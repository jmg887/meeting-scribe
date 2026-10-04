import os
import uuid
import json
import tempfile
import subprocess
from typing import Optional

import boto3
import torch
import soundfile as sf
from botocore.config import Config
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from faster_whisper import WhisperModel
from pyannote.audio import Pipeline as DiarizationPipeline

AWS_REGION = os.environ.get("AWS_REGION", "eu-north-1")
S3_BUCKET = os.environ.get("S3_BUCKET", "meetingscribe-audio-8k2p1")
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
HF_TOKEN = os.environ.get("HF_TOKEN")
SUMMARY_MODEL_ID = os.environ.get(
    "SUMMARY_MODEL_ID", "eu.anthropic.claude-haiku-4-5-20251001-v1:0"
)
PAUSE_THRESHOLD_SECONDS = 1.5

app = FastAPI(title="Meeting Transcription Service")

s3_client = boto3.client("s3", region_name=AWS_REGION, config=Config(signature_version="s3v4"))
bedrock_client = boto3.client("bedrock-runtime", region_name=AWS_REGION)

print(f"Loading Whisper model '{WHISPER_MODEL_SIZE}' on {WHISPER_DEVICE}...")
model = WhisperModel(WHISPER_MODEL_SIZE, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
print("Whisper model loaded.")

diarization_pipeline = None
if HF_TOKEN:
    print("Loading speaker diarization model...")
    diarization_pipeline = DiarizationPipeline.from_pretrained(
        "pyannote/speaker-diarization-community-1", token=HF_TOKEN
    )
    print("Diarization model loaded.")
else:
    print("HF_TOKEN not set - speaker diarization disabled.")

JOBS: dict[str, dict] = {}


class UploadUrlRequest(BaseModel):
    filename: str


class UploadUrlResponse(BaseModel):
    upload_url: str
    s3_key: str


class TranscribeRequest(BaseModel):
    s3_key: str
    num_speakers: Optional[int] = None


class TranscribeResponse(BaseModel):
    job_id: str


class StatusResponse(BaseModel):
    job_id: str
    status: str
    transcript: Optional[str] = None
    summary: Optional[str] = None
    action_items: Optional[list[str]] = None
    summary_error: Optional[str] = None
    error: Optional[str] = None


@app.post("/upload-url", response_model=UploadUrlResponse)
def get_upload_url(req: UploadUrlRequest):
    s3_key = f"audio/{uuid.uuid4()}-{req.filename}"
    upload_url = s3_client.generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": S3_BUCKET, "Key": s3_key},
        ExpiresIn=3600,
    )
    return UploadUrlResponse(upload_url=upload_url, s3_key=s3_key)


@app.post("/transcribe", response_model=TranscribeResponse)
def start_transcription(req: TranscribeRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    JOBS[job_id] = {
        "status": "processing", "transcript": None, "summary": None,
        "action_items": None, "summary_error": None, "error": None,
    }
    background_tasks.add_task(run_transcription_job, job_id, req.s3_key, req.num_speakers)
    return TranscribeResponse(job_id=job_id)


@app.get("/status/{job_id}", response_model=StatusResponse)
def get_status(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job_id not found")
    return StatusResponse(job_id=job_id, **job)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": WHISPER_MODEL_SIZE,
        "device": WHISPER_DEVICE,
        "diarization_enabled": diarization_pipeline is not None,
        "summary_model": SUMMARY_MODEL_ID,
    }


def build_speaker_diarization_wav(source_path: str) -> str:
    wav_path = source_path + ".diarization.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", source_path, "-ar", "16000", "-ac", "1", wav_path],
        check=True,
        capture_output=True,
    )
    return wav_path


def run_diarization(wav_path: str, num_speakers: Optional[int]):
    audio, sr = sf.read(wav_path)
    waveform = torch.tensor(audio).float().unsqueeze(0)
    kwargs = {}
    if num_speakers:
        kwargs["num_speakers"] = num_speakers
    output = diarization_pipeline({"waveform": waveform, "sample_rate": sr}, **kwargs)
    turns = [
        (turn.start, turn.end, speaker)
        for turn, speaker in output.speaker_diarization
    ]
    return turns


def assign_speaker(seg_start: float, seg_end: float, turns: list) -> Optional[str]:
    best_speaker = None
    best_overlap = 0.0
    for turn_start, turn_end, speaker in turns:
        overlap = min(seg_end, turn_end) - max(seg_start, turn_start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = speaker
    if best_speaker is None and turns:
        seg_mid = (seg_start + seg_end) / 2
        best_speaker = min(turns, key=lambda t: abs(((t[0] + t[1]) / 2) - seg_mid))[2]
    return best_speaker


def build_transcript_text(segment_list, turns: list) -> str:
    speaker_map: dict[str, str] = {}
    next_speaker_num = 1

    def label_for(raw_speaker: Optional[str]) -> Optional[str]:
        nonlocal next_speaker_num
        if raw_speaker is None:
            return None
        if raw_speaker not in speaker_map:
            speaker_map[raw_speaker] = f"Speaker {next_speaker_num}"
            next_speaker_num += 1
        return speaker_map[raw_speaker]

    paragraphs = []
    current_label = None
    current_lines: list[str] = []
    prev_end = None

    for seg in segment_list:
        text = seg.text.strip()
        raw_speaker = assign_speaker(seg.start, seg.end, turns) if turns else None
        label = label_for(raw_speaker)

        speaker_changed = label is not None and label != current_label
        long_pause = prev_end is not None and (seg.start - prev_end) > PAUSE_THRESHOLD_SECONDS

        if current_lines and (speaker_changed or long_pause):
            prefix = f"{current_label}: " if current_label else ""
            paragraphs.append(prefix + " ".join(current_lines))
            current_lines = []

        if label is not None:
            current_label = label
        current_lines.append(text)
        prev_end = seg.end

    if current_lines:
        prefix = f"{current_label}: " if current_label else ""
        paragraphs.append(prefix + " ".join(current_lines))

    return "\n\n".join(paragraphs)


def generate_summary_and_actions(transcript_text: str):
    if not transcript_text.strip():
        return None, [], None

    tool_schema = {
        "toolSpec": {
            "name": "record_summary",
            "description": "Record a concise summary and action items for this meeting/recording transcript.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "summary": {
                            "type": "string",
                            "description": "A clear 2-4 sentence summary covering the key topics discussed and any decisions made.",
                        },
                        "action_items": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Concrete action items, tasks, or follow-ups mentioned. Empty array if none were mentioned.",
                        },
                    },
                    "required": ["summary", "action_items"],
                }
            },
        }
    }

    prompt = (
        "Here is a transcript of a recording (may include speaker labels). "
        "Summarize it and extract any action items.\n\n"
        f"TRANSCRIPT:\n{transcript_text}"
    )

    try:
        response = bedrock_client.converse(
            modelId=SUMMARY_MODEL_ID,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            toolConfig={
                "tools": [tool_schema],
                "toolChoice": {"tool": {"name": "record_summary"}},
            },
        )
        content_blocks = response["output"]["message"]["content"]
        tool_use = next(b["toolUse"] for b in content_blocks if "toolUse" in b)
        result = tool_use["input"]
        summary = result.get("summary", "").strip()
        action_items = result.get("action_items", []) or []
        return summary, action_items, None
    except Exception as exc:
        return None, [], str(exc)


def run_transcription_job(job_id: str, s3_key: str, num_speakers: Optional[int]):
    local_path = None
    diarization_wav_path = None
    try:
        suffix = os.path.splitext(s3_key)[1] or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            local_path = tmp.name
        s3_client.download_file(S3_BUCKET, s3_key, local_path)

        segments, info = model.transcribe(local_path, beam_size=5)
        segment_list = list(segments)

        turns = []
        if diarization_pipeline is not None:
            diarization_wav_path = build_speaker_diarization_wav(local_path)
            turns = run_diarization(diarization_wav_path, num_speakers)

        transcript_text = build_transcript_text(segment_list, turns)

        summary, action_items, summary_error = generate_summary_and_actions(transcript_text)

        transcript_key = s3_key.replace("audio/", "transcripts/") + ".txt"
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=transcript_key,
            Body=transcript_text.encode("utf-8"),
        )

        if summary is not None:
            summary_key = s3_key.replace("audio/", "transcripts/") + ".summary.json"
            s3_client.put_object(
                Bucket=S3_BUCKET,
                Key=summary_key,
                Body=json.dumps({"summary": summary, "action_items": action_items}).encode("utf-8"),
            )

        JOBS[job_id] = {
            "status": "done",
            "transcript": transcript_text,
            "summary": summary,
            "action_items": action_items,
            "summary_error": summary_error,
            "error": None,
        }

    except Exception as exc:
        JOBS[job_id] = {
            "status": "error", "transcript": None, "summary": None,
            "action_items": None, "summary_error": None, "error": str(exc),
        }

    finally:
        if local_path and os.path.exists(local_path):
            os.remove(local_path)
        if diarization_wav_path and os.path.exists(diarization_wav_path):
            os.remove(diarization_wav_path)
