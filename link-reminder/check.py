"""
Link Reminder Check Script
Runs every 5 minutes via Windows Task Scheduler.
Detects when user returns to laptop and delivers pending reminders.

Two signals trigger delivery:
  1. Idle drop: user was away (idle > 5 min) and is now active (idle < 90s)
  2. Wake from sleep: gap since last run > 10 min AND user is now active
"""

import ctypes
import json
import os
import sys
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).parent
REMINDERS_FILE = BASE_DIR / 'reminders.json'
STATE_FILE = BASE_DIR / 'state.json'

AWAY_THRESHOLD_SECONDS = 300   # 5 minutes: consider user "away"
ACTIVE_THRESHOLD_SECONDS = 90  # 90 seconds: consider user "just returned"
SLEEP_GAP_SECONDS = 600        # 10 minutes: gap implies laptop was sleeping

PENDING_URL = 'http://localhost:3000/pending'


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [
        ('cbSize', ctypes.c_uint),
        ('dwTime', ctypes.c_uint),
    ]


def get_idle_seconds() -> float:
    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    ok = ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii))
    if not ok:
        return 0.0
    tick_now = ctypes.windll.kernel32.GetTickCount()
    idle_ms = tick_now - lii.dwTime
    # GetTickCount wraps at ~49.7 days; handle rollover
    if idle_ms < 0:
        idle_ms += 2 ** 32
    return idle_ms / 1000.0


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            pass
    return {'last_idle_was_high': False, 'last_run_ts': None}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(
        json.dumps(state, indent=2),
        encoding='utf-8',
    )


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


def has_pending(reminders: list) -> bool:
    return any(not r.get('delivered') for r in reminders)


def mark_all_delivered(reminders: list) -> list:
    for r in reminders:
        r['delivered'] = True
    return reminders


def seconds_since_last_run(last_run_ts: str | None) -> float | None:
    if not last_run_ts:
        return None
    try:
        last = datetime.fromisoformat(last_run_ts)
        now = datetime.now(tz=timezone.utc).replace(tzinfo=None)
        if last.tzinfo is not None:
            last = last.replace(tzinfo=None)
        return (now - last).total_seconds()
    except ValueError:
        return None


def main():
    idle = get_idle_seconds()
    state = load_state()
    now_ts = datetime.now(tz=timezone.utc).isoformat(timespec='seconds')

    last_idle_was_high = state.get('last_idle_was_high', False)
    last_run_ts = state.get('last_run_ts')

    gap = seconds_since_last_run(last_run_ts)
    woke_from_sleep = gap is not None and gap > SLEEP_GAP_SECONDS

    user_just_returned = (
        idle < ACTIVE_THRESHOLD_SECONDS
        and (last_idle_was_high or woke_from_sleep)
    )

    if user_just_returned:
        reminders = load_reminders()
        if has_pending(reminders):
            webbrowser.open(PENDING_URL)
            reminders = mark_all_delivered(reminders)
            save_reminders(reminders)

    # Update state for next run
    new_state = {
        'last_idle_was_high': idle > AWAY_THRESHOLD_SECONDS,
        'last_run_ts': now_ts,
    }
    save_state(new_state)


if __name__ == '__main__':
    if sys.platform != 'win32':
        print('check.py only works on Windows (requires GetLastInputInfo).')
        sys.exit(1)
    main()
