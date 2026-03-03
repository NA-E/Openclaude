"""
Link Reminder Server
Serves the chat UI and saves reminders to reminders.json.
Run this at startup via Task Scheduler (pythonw server.py).
"""

import json
import os
import re
import subprocess
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).parent
REMINDERS_FILE = BASE_DIR / 'reminders.json'
STATIC_DIR = BASE_DIR / 'static'

app = Flask(__name__, static_folder=str(STATIC_DIR))

URL_PATTERN = re.compile(r'https?://\S+')


def load_reminders() -> list:
    if not REMINDERS_FILE.exists():
        return []
    try:
        return json.loads(REMINDERS_FILE.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        return []


def save_reminders(reminders: list) -> None:
    REMINDERS_FILE.write_text(
        json.dumps(reminders, indent=2, ensure_ascii=False),
        encoding='utf-8',
    )


def extract_url(message: str) -> str | None:
    match = URL_PATTERN.search(message)
    return match.group(0).rstrip('.,;:)\'\"') if match else None


def extract_note(message: str, url: str | None) -> str:
    if url:
        note = URL_PATTERN.sub('', message).strip()
        # Clean up filler phrases
        filler = re.compile(
            r'\b(remember|save|remind me|when i (sit down|get back|return|am back)|check (this|it) out|this link|please|and|to)\b',
            re.IGNORECASE,
        )
        note = filler.sub('', note).strip(' ,.-')
        note = re.sub(r'\s{2,}', ' ', note).strip()
    else:
        note = message.strip()

    if not note and url:
        note = 'Check this link'

    return note


def try_claude_summary(message: str) -> str | None:
    """Optionally use claude CLI for smarter note extraction. Falls back gracefully."""
    try:
        result = subprocess.run(
            ['claude', '-p', f'Extract a short (max 10 words) reminder note from this message. Return only the note, nothing else: "{message}"'],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return None


@app.route('/')
def index():
    return send_from_directory(str(STATIC_DIR), 'index.html')


@app.route('/remind', methods=['POST'])
def save_reminder():
    data = request.get_json(silent=True) or {}
    message = (data.get('message') or '').strip()

    if not message:
        return jsonify({'error': 'message is required'}), 400

    url = extract_url(message)
    note = extract_note(message, url)

    # If note is still generic, try claude CLI for a better summary
    if note in ('Check this link', '') and url:
        claude_note = try_claude_summary(message)
        if claude_note:
            note = claude_note

    reminder = {
        'id': str(uuid.uuid4()),
        'url': url,
        'note': note,
        'created_at': datetime.now().isoformat(timespec='seconds'),
        'delivered': False,
    }

    reminders = load_reminders()
    reminders.append(reminder)
    save_reminders(reminders)

    return jsonify({'status': 'saved', 'url': url, 'note': note})


@app.route('/pending')
def pending_page():
    reminders = [r for r in load_reminders() if not r.get('delivered')]
    items_html = ''
    if reminders:
        for r in reminders:
            url_display = r.get('url') or '(no URL)'
            note = r.get('note', '')
            created = r.get('created_at', '')
            link_tag = (
                f'<a href="{r["url"]}" target="_blank" rel="noopener">{r["url"]}</a>'
                if r.get('url') else '<span class="no-url">(no URL)</span>'
            )
            items_html += f'''
            <div class="reminder">
              <div class="note">{note}</div>
              <div class="url">{link_tag}</div>
              <div class="meta">Saved {created}</div>
            </div>'''
    else:
        items_html = '<div class="empty">No pending reminders.</div>'

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Pending Reminders</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ background: #0f0f0f; color: #e0e0e0; font-family: system-ui, sans-serif; padding: 32px; }}
    h1 {{ font-size: 1.4rem; margin-bottom: 24px; color: #fff; }}
    .reminder {{ background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px;
                padding: 20px; margin-bottom: 16px; }}
    .note {{ font-size: 1.1rem; font-weight: 600; margin-bottom: 10px; }}
    .url {{ font-size: 0.95rem; margin-bottom: 6px; word-break: break-all; }}
    .url a {{ color: #4ea1f3; text-decoration: none; }}
    .url a:hover {{ text-decoration: underline; }}
    .no-url {{ color: #666; }}
    .meta {{ font-size: 0.8rem; color: #555; }}
    .empty {{ color: #555; font-size: 1rem; }}
    .actions {{ margin-top: 28px; }}
    button {{ background: #222; color: #ccc; border: 1px solid #333; border-radius: 6px;
              padding: 10px 20px; cursor: pointer; font-size: 0.9rem; }}
    button:hover {{ background: #2a2a2a; }}
  </style>
</head>
<body>
  <h1>Reminders waiting for you</h1>
  {items_html}
  {"<div class='actions'><button onclick='markDone()'>Mark all done</button></div>" if reminders else ""}
  <script>
    async function markDone() {{
      await fetch('/mark-delivered', {{ method: 'POST' }});
      location.reload();
    }}
  </script>
</body>
</html>'''


@app.route('/mark-delivered', methods=['POST'])
def mark_delivered():
    reminders = load_reminders()
    for r in reminders:
        r['delivered'] = True
    save_reminders(reminders)
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    print('Link Reminder running at http://localhost:3000')
    app.run(host='127.0.0.1', port=3000, debug=False)
