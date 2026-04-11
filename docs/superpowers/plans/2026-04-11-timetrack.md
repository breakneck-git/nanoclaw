# TimeTrack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone Python tool that syncs ActivityWatch activity data into Notion Time Log and sets up a daily Claude Code scheduled task for AI classification of entries.

**Architecture:** `timetrack sync` is a CLI command installed as a launchd service (every 15 min). It reads ActivityWatch REST API, groups window events into focus blocks, and pushes new entries to Notion Time Log. A Claude Code scheduled task runs daily at 23:00, queries `Sorted = false` entries, matches each to an active Notion Task via AI, and sets `Sorted = true`.

**Tech Stack:** Python 3.11+, `notion-client`, `requests`, `pytest`, `responses` (HTTP mocking), launchd (macOS)

---

## File Map

```
~/timetrack/
├── timetrack/
│   ├── __init__.py         empty
│   ├── config.py           loads ~/.config/timetrack/config.toml
│   ├── state.py            reads/writes ~/.config/timetrack/state.json
│   ├── blocks.py           AWEvent, AFKEvent, FocusBlock dataclasses + compute_focus_blocks()
│   ├── activitywatch.py    AW REST client (HTTP, bucket discovery, event fetching)
│   ├── notion.py           NotionTimeLogClient (creates Time Log entries)
│   └── cli.py              `timetrack sync` entry point — wires everything together
├── tests/
│   ├── __init__.py         empty
│   ├── test_blocks.py      unit tests for focus block algorithm (no HTTP)
│   ├── test_activitywatch.py  tests with `responses` HTTP mocking
│   ├── test_state.py       tests with tmp_path
│   └── test_notion.py      tests with `responses` HTTP mocking
├── com.timetrack.sync.plist   launchd plist template (uses TIMETRACK_BIN / LOG_DIR placeholders)
├── install.sh              creates venv, installs package, writes config template, loads plist
└── pyproject.toml
```

---

## Task 1: Notion Integration Setup + Project Scaffold

**Files:**
- Create: `~/timetrack/pyproject.toml`
- Create: `~/timetrack/timetrack/__init__.py`
- Create: `~/timetrack/tests/__init__.py`

Before writing code: create a Notion Internal Integration so the sync script can write to Time Log.

- [ ] **Step 1: Create Notion integration**

  Go to https://www.notion.so/my-integrations → New integration → name "TimeTrack" → Internal → Save.
  Copy the **Internal Integration Secret** (starts with `secret_...`).

  Open the **Time Log** database in Notion → `...` menu → **Connections** → add "TimeTrack".
  Repeat for the **Tasks** database.

- [ ] **Step 2: Create project directory**

  ```bash
  mkdir -p ~/timetrack/timetrack ~/timetrack/tests
  cd ~/timetrack
  git init
  ```

- [ ] **Step 3: Create pyproject.toml**

  ```toml
  [build-system]
  requires = ["hatchling"]
  build-backend = "hatchling.build"

  [project]
  name = "timetrack"
  version = "0.1.0"
  requires-python = ">=3.11"
  dependencies = [
      "notion-client>=2.3.0",
      "requests>=2.31.0",
  ]

  [project.scripts]
  timetrack = "timetrack.cli:main"

  [dependency-groups]
  dev = [
      "pytest>=8.0",
      "responses>=0.25.3",
  ]
  ```

- [ ] **Step 4: Create empty init files**

  ```bash
  touch ~/timetrack/timetrack/__init__.py
  touch ~/timetrack/tests/__init__.py
  ```

- [ ] **Step 5: Create venv and install**

  ```bash
  cd ~/timetrack
  python3.11 -m venv .venv
  source .venv/bin/activate
  pip install -e ".[dev]"
  ```

  Expected: `Successfully installed timetrack-0.1.0`

- [ ] **Step 6: Verify CLI entry point exists**

  ```bash
  timetrack
  ```

  Expected: `Usage: timetrack sync` (will fail since cli.py doesn't exist yet — that's fine)

- [ ] **Step 7: Commit**

  ```bash
  git add pyproject.toml timetrack/__init__.py tests/__init__.py
  git commit -m "feat: project scaffold"
  ```

---

## Task 2: config.py

**Files:**
- Create: `~/timetrack/timetrack/config.py`
- Create: `~/timetrack/tests/test_config.py`

- [ ] **Step 1: Write failing test**

  `tests/test_config.py`:
  ```python
  import tomllib
  from pathlib import Path
  import pytest
  from timetrack.config import load_config, Config, NotionConfig

  def test_load_config(tmp_path):
      cfg_file = tmp_path / "config.toml"
      cfg_file.write_text("""
  timezone = "Europe/Moscow"

  [notion]
  token = "secret_abc123"
  timelog_db = "35b4cfe8-1f3a-457a-80a8-fe61aa465a18"

  [activitywatch]
  afk_threshold_min = 15
  """)
      cfg = load_config(cfg_file)
      assert cfg.notion.token == "secret_abc123"
      assert cfg.notion.timelog_db == "35b4cfe8-1f3a-457a-80a8-fe61aa465a18"
      assert cfg.timezone == "Europe/Moscow"
      assert cfg.activitywatch.afk_threshold_min == 15
      assert cfg.activitywatch.min_block_duration_sec == 120  # default
      assert cfg.sync.initial_sync_days == 7  # default

  def test_missing_config_raises(tmp_path):
      with pytest.raises(FileNotFoundError):
          load_config(tmp_path / "nonexistent.toml")

  def test_defaults(tmp_path):
      cfg_file = tmp_path / "config.toml"
      cfg_file.write_text("""
  [notion]
  token = "secret_x"
  timelog_db = "db-id"
  """)
      cfg = load_config(cfg_file)
      assert cfg.activitywatch.base_url == "http://localhost:5600"
      assert cfg.activitywatch.merge_gap_sec == 180
      assert cfg.timezone == "UTC"
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  cd ~/timetrack && source .venv/bin/activate
  pytest tests/test_config.py -v
  ```

  Expected: `ImportError: cannot import name 'load_config'`

- [ ] **Step 3: Implement config.py**

  `timetrack/config.py`:
  ```python
  import tomllib
  from dataclasses import dataclass, field
  from pathlib import Path

  CONFIG_PATH = Path.home() / ".config" / "timetrack" / "config.toml"


  @dataclass
  class NotionConfig:
      token: str
      timelog_db: str


  @dataclass
  class ActivityWatchConfig:
      base_url: str = "http://localhost:5600"
      afk_threshold_min: int = 10
      min_block_duration_sec: int = 120
      merge_gap_sec: int = 180


  @dataclass
  class SyncConfig:
      initial_sync_days: int = 7


  @dataclass
  class Config:
      notion: NotionConfig
      activitywatch: ActivityWatchConfig = field(default_factory=ActivityWatchConfig)
      sync: SyncConfig = field(default_factory=SyncConfig)
      timezone: str = "UTC"


  def load_config(path: Path = CONFIG_PATH) -> Config:
      if not path.exists():
          raise FileNotFoundError(
              f"Config not found: {path}\n"
              "Create it — see config template in install.sh."
          )
      with open(path, "rb") as f:
          data = tomllib.load(f)

      n = data["notion"]
      aw = data.get("activitywatch", {})
      s = data.get("sync", {})

      return Config(
          notion=NotionConfig(
              token=n["token"],
              timelog_db=n["timelog_db"],
          ),
          activitywatch=ActivityWatchConfig(
              base_url=aw.get("base_url", "http://localhost:5600"),
              afk_threshold_min=aw.get("afk_threshold_min", 10),
              min_block_duration_sec=aw.get("min_block_duration_sec", 120),
              merge_gap_sec=aw.get("merge_gap_sec", 180),
          ),
          sync=SyncConfig(
              initial_sync_days=s.get("initial_sync_days", 7),
          ),
          timezone=data.get("timezone", "UTC"),
      )
  ```

- [ ] **Step 4: Run tests**

  ```bash
  pytest tests/test_config.py -v
  ```

  Expected: `3 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add timetrack/config.py tests/test_config.py
  git commit -m "feat: config loading from toml"
  ```

---

## Task 3: state.py

**Files:**
- Create: `~/timetrack/timetrack/state.py`
- Create: `~/timetrack/tests/test_state.py`

- [ ] **Step 1: Write failing test**

  `tests/test_state.py`:
  ```python
  from datetime import datetime, timezone
  from timetrack.state import State

  def test_first_run_is_empty(tmp_path):
      state = State.load(tmp_path / "state.json")
      assert state.last_sync is None
      assert state.notion_entries == {}

  def test_save_and_reload(tmp_path):
      path = tmp_path / "state.json"
      state = State.load(path)
      state.last_sync = datetime(2026, 4, 11, 22, 0, tzinfo=timezone.utc)
      state.notion_entries["abc123"] = "notion-page-id-xyz"
      state.save(path)

      reloaded = State.load(path)
      assert reloaded.last_sync == datetime(2026, 4, 11, 22, 0, tzinfo=timezone.utc)
      assert reloaded.notion_entries["abc123"] == "notion-page-id-xyz"

  def test_save_creates_parent_dirs(tmp_path):
      path = tmp_path / "nested" / "dir" / "state.json"
      state = State.load(path)
      state.save(path)
      assert path.exists()
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  pytest tests/test_state.py -v
  ```

  Expected: `ImportError: cannot import name 'State'`

- [ ] **Step 3: Implement state.py**

  `timetrack/state.py`:
  ```python
  import json
  from dataclasses import dataclass, field
  from datetime import datetime
  from pathlib import Path

  STATE_PATH = Path.home() / ".config" / "timetrack" / "state.json"


  @dataclass
  class State:
      last_sync: datetime | None = None
      notion_entries: dict[str, str] = field(default_factory=dict)

      @classmethod
      def load(cls, path: Path = STATE_PATH) -> "State":
          if not path.exists():
              return cls()
          with open(path) as f:
              data = json.load(f)
          last_sync = None
          if data.get("last_sync"):
              last_sync = datetime.fromisoformat(data["last_sync"])
          return cls(
              last_sync=last_sync,
              notion_entries=data.get("notion_entries", {}),
          )

      def save(self, path: Path = STATE_PATH) -> None:
          path.parent.mkdir(parents=True, exist_ok=True)
          data = {
              "last_sync": self.last_sync.isoformat() if self.last_sync else None,
              "notion_entries": self.notion_entries,
          }
          with open(path, "w") as f:
              json.dump(data, f, indent=2)
  ```

- [ ] **Step 4: Run tests**

  ```bash
  pytest tests/test_state.py -v
  ```

  Expected: `3 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add timetrack/state.py tests/test_state.py
  git commit -m "feat: state persistence (cursor + dedup map)"
  ```

---

## Task 4: blocks.py — data structures + focus block algorithm

**Files:**
- Create: `~/timetrack/timetrack/blocks.py`
- Create: `~/timetrack/tests/test_blocks.py`

This module is pure logic — no HTTP, no I/O. All timestamps are UTC-aware `datetime` objects.

- [ ] **Step 1: Write failing tests**

  `tests/test_blocks.py`:
  ```python
  from datetime import datetime, timedelta, timezone
  from timetrack.blocks import AWEvent, AFKEvent, FocusBlock, compute_focus_blocks

  def dt(offset_sec: float) -> datetime:
      """Helper: UTC datetime at base + offset_sec."""
      base = datetime(2026, 4, 11, 10, 0, 0, tzinfo=timezone.utc)
      return base + timedelta(seconds=offset_sec)


  def win(offset_sec: float, duration: float, app: str, title: str, url=None) -> AWEvent:
      return AWEvent(timestamp=dt(offset_sec), duration=duration, app=app, title=title, url=url)


  def afk(offset_sec: float, duration: float) -> AFKEvent:
      return AFKEvent(timestamp=dt(offset_sec), duration=duration, status="afk")


  def test_single_event_above_minimum():
      events = [win(0, 200, "Code", "file.py")]
      blocks = compute_focus_blocks(events, [])
      assert len(blocks) == 1
      assert blocks[0].app == "Code"
      assert blocks[0].title == "file.py"
      assert blocks[0].active_seconds == 200

  def test_single_event_below_minimum_filtered():
      events = [win(0, 60, "Code", "file.py")]  # 60s < 120s min
      blocks = compute_focus_blocks(events, [])
      assert blocks == []

  def test_same_app_title_gap_under_merge_threshold_merges():
      events = [
          win(0, 100, "Code", "file.py"),
          win(200, 100, "Code", "file.py"),  # gap = 100s < 180s → merge
      ]
      blocks = compute_focus_blocks(events, [])
      assert len(blocks) == 1
      assert blocks[0].active_seconds == 200

  def test_same_app_title_gap_over_merge_threshold_splits():
      events = [
          win(0, 100, "Code", "file.py"),
          win(400, 100, "Code", "file.py"),  # gap = 300s > 180s → split
      ]
      blocks = compute_focus_blocks(events, [])
      assert len(blocks) == 2

  def test_different_app_creates_new_block():
      events = [
          win(0, 200, "Code", "file.py"),
          win(200, 200, "Chrome", "GitHub"),
      ]
      blocks = compute_focus_blocks(events, [])
      assert len(blocks) == 2
      assert blocks[0].app == "Code"
      assert blocks[1].app == "Chrome"

  def test_afk_event_filters_window_events():
      events = [
          win(0, 200, "Code", "file.py"),
          win(300, 200, "Code", "file.py"),  # during AFK
      ]
      afk_events = [afk(250, 400)]  # AFK from t=250 to t=650
      blocks = compute_focus_blocks(events, afk_events)
      assert len(blocks) == 1
      assert blocks[0].active_seconds == 200

  def test_afk_gap_over_threshold_is_hard_boundary():
      events = [
          win(0, 100, "Code", "file.py"),
          win(800, 100, "Code", "file.py"),  # gap = 700s > 600s threshold
      ]
      blocks = compute_focus_blocks(events, [])
      # Hard boundary: two separate blocks (both >= 100s... wait, 100s < 120s min)
      # With min_duration_sec=120, both would be filtered. Let's use 150s.

  def test_afk_hard_boundary_separates_blocks():
      events = [
          win(0, 150, "Code", "file.py"),
          win(800, 150, "Code", "file.py"),  # gap = 650s > 600s threshold
      ]
      blocks = compute_focus_blocks(events, [])
      assert len(blocks) == 2

  def test_url_preserved_in_block():
      events = [win(0, 200, "Chrome", "GitHub", url="https://github.com/x/y")]
      blocks = compute_focus_blocks(events, [])
      assert len(blocks) == 1
      assert blocks[0].url == "https://github.com/x/y"

  def test_empty_events_returns_empty():
      assert compute_focus_blocks([], []) == []

  def test_block_signature_is_stable():
      events = [win(0, 200, "Code", "file.py")]
      b1 = compute_focus_blocks(events, [])[0]
      b2 = compute_focus_blocks(events, [])[0]
      assert b1.signature() == b2.signature()

  def test_block_active_minutes_rounds():
      events = [win(0, 190, "Code", "file.py")]  # 190s = 3.16 min → rounds to 3
      blocks = compute_focus_blocks(events, [])
      assert blocks[0].active_minutes() == 3
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/test_blocks.py -v
  ```

  Expected: `ImportError: cannot import name 'AWEvent'`

- [ ] **Step 3: Implement blocks.py**

  `timetrack/blocks.py`:
  ```python
  import hashlib
  from dataclasses import dataclass
  from datetime import datetime, timedelta, timezone
  from zoneinfo import ZoneInfo


  @dataclass
  class AWEvent:
      timestamp: datetime   # UTC-aware
      duration: float       # seconds
      app: str
      title: str
      url: str | None = None


  @dataclass
  class AFKEvent:
      timestamp: datetime   # UTC-aware
      duration: float       # seconds
      status: str           # "afk" | "not-afk"


  @dataclass
  class FocusBlock:
      app: str
      title: str
      start_utc: datetime
      end_utc: datetime
      active_seconds: float
      url: str | None = None

      def start_local(self, tz: ZoneInfo) -> datetime:
          return self.start_utc.astimezone(tz)

      def end_local(self, tz: ZoneInfo) -> datetime:
          return self.end_utc.astimezone(tz)

      def active_minutes(self) -> int:
          return round(self.active_seconds / 60)

      def signature(self) -> str:
          raw = f"{self.app}|{self.title}|{self.start_utc.isoformat()}"
          return hashlib.sha256(raw.encode()).hexdigest()[:16]


  def compute_focus_blocks(
      window_events: list[AWEvent],
      afk_events: list[AFKEvent],
      *,
      afk_threshold_sec: int = 600,
      merge_gap_sec: int = 180,
      min_duration_sec: int = 120,
  ) -> list[FocusBlock]:
      """Group window events into focus blocks, skipping AFK periods."""
      afk_intervals = [
          (e.timestamp, e.timestamp + timedelta(seconds=e.duration))
          for e in afk_events
          if e.status == "afk"
      ]

      def is_afk(ts: datetime) -> bool:
          return any(s <= ts < e for s, e in afk_intervals)

      active = sorted(
          [e for e in window_events if not is_afk(e.timestamp)],
          key=lambda e: e.timestamp,
      )

      if not active:
          return []

      blocks: list[FocusBlock] = []
      first = active[0]
      cur = FocusBlock(
          app=first.app,
          title=first.title,
          start_utc=first.timestamp,
          end_utc=first.timestamp + timedelta(seconds=first.duration),
          active_seconds=first.duration,
          url=first.url,
      )

      for event in active[1:]:
          event_end = event.timestamp + timedelta(seconds=event.duration)
          gap_sec = (event.timestamp - cur.end_utc).total_seconds()
          same = event.app == cur.app and event.title == cur.title

          if gap_sec > afk_threshold_sec:
              if cur.active_seconds >= min_duration_sec:
                  blocks.append(cur)
              cur = FocusBlock(
                  app=event.app, title=event.title,
                  start_utc=event.timestamp, end_utc=event_end,
                  active_seconds=event.duration, url=event.url,
              )
          elif same and gap_sec <= merge_gap_sec:
              cur.end_utc = event_end
              cur.active_seconds += event.duration
          else:
              if cur.active_seconds >= min_duration_sec:
                  blocks.append(cur)
              cur = FocusBlock(
                  app=event.app, title=event.title,
                  start_utc=event.timestamp, end_utc=event_end,
                  active_seconds=event.duration, url=event.url,
              )

      if cur.active_seconds >= min_duration_sec:
          blocks.append(cur)

      return blocks
  ```

- [ ] **Step 4: Run tests**

  ```bash
  pytest tests/test_blocks.py -v
  ```

  Expected: `11 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add timetrack/blocks.py tests/test_blocks.py
  git commit -m "feat: focus block algorithm with AFK filtering"
  ```

---

## Task 5: activitywatch.py — AW REST client

**Files:**
- Create: `~/timetrack/timetrack/activitywatch.py`
- Create: `~/timetrack/tests/test_activitywatch.py`

- [ ] **Step 1: Write failing tests**

  `tests/test_activitywatch.py`:
  ```python
  from datetime import datetime, timezone
  import responses as resp_mock
  import responses
  from timetrack.activitywatch import ActivityWatchClient

  BASE = "http://localhost:5600/api/0"

  BUCKETS = {
      "aw-watcher-window_testhost": {"type": "currentwindow"},
      "aw-watcher-afk_testhost": {"type": "afkstatus"},
  }

  WINDOW_EVENTS = [
      {
          "id": 1,
          "timestamp": "2026-04-11T10:00:00.000000+00:00",
          "duration": 300.0,
          "data": {"app": "Code", "title": "file.py — VS Code"},
      },
      {
          "id": 2,
          "timestamp": "2026-04-11T10:05:00.000000+00:00",
          "duration": 200.0,
          "data": {"app": "Code", "title": "test.py — VS Code"},
      },
  ]

  AFK_EVENTS = [
      {
          "id": 3,
          "timestamp": "2026-04-11T10:10:00.000000+00:00",
          "duration": 600.0,
          "data": {"status": "afk"},
      }
  ]

  @responses.activate
  def test_is_running_true():
      responses.add(responses.GET, f"{BASE}/info", json={"version": "0.12"})
      client = ActivityWatchClient()
      assert client.is_running() is True

  @responses.activate
  def test_is_running_false_when_connection_error():
      # No mock registered → connection error
      client = ActivityWatchClient()
      assert client.is_running() is False

  @responses.activate
  def test_get_all_events_returns_window_and_afk():
      responses.add(responses.GET, f"{BASE}/buckets", json=BUCKETS)
      responses.add(
          responses.GET,
          f"{BASE}/buckets/aw-watcher-window_testhost/events",
          json=WINDOW_EVENTS,
      )
      responses.add(
          responses.GET,
          f"{BASE}/buckets/aw-watcher-afk_testhost/events",
          json=AFK_EVENTS,
      )
      client = ActivityWatchClient()
      start = datetime(2026, 4, 11, 10, 0, tzinfo=timezone.utc)
      end = datetime(2026, 4, 11, 11, 0, tzinfo=timezone.utc)
      window_events, afk_events = client.get_all_events(start, end)
      assert len(window_events) == 2
      assert window_events[0].app == "Code"
      assert window_events[0].duration == 300.0
      assert len(afk_events) == 1
      assert afk_events[0].status == "afk"

  @responses.activate
  def test_web_watcher_events_replace_browser_window_events():
      buckets_with_web = {
          **BUCKETS,
          "aw-watcher-web-chrome": {"type": "web.tab.current"},
      }
      web_events = [
          {
              "id": 10,
              "timestamp": "2026-04-11T10:00:00.000000+00:00",
              "duration": 120.0,
              "data": {
                  "app": "Google Chrome",
                  "title": "GitHub",
                  "url": "https://github.com/x/y",
              },
          }
      ]
      window_events_with_chrome = [
          *WINDOW_EVENTS,
          {
              "id": 5,
              "timestamp": "2026-04-11T10:07:00.000000+00:00",
              "duration": 120.0,
              "data": {"app": "Google Chrome", "title": "GitHub"},
          },
      ]
      responses.add(responses.GET, f"{BASE}/buckets", json=buckets_with_web)
      responses.add(
          responses.GET,
          f"{BASE}/buckets/aw-watcher-window_testhost/events",
          json=window_events_with_chrome,
      )
      responses.add(
          responses.GET,
          f"{BASE}/buckets/aw-watcher-afk_testhost/events",
          json=AFK_EVENTS,
      )
      responses.add(
          responses.GET,
          f"{BASE}/buckets/aw-watcher-web-chrome/events",
          json=web_events,
      )
      client = ActivityWatchClient()
      start = datetime(2026, 4, 11, 10, 0, tzinfo=timezone.utc)
      end = datetime(2026, 4, 11, 11, 0, tzinfo=timezone.utc)
      window, _ = client.get_all_events(start, end)
      # Chrome window event should be replaced by web event (with URL)
      chrome_events = [e for e in window if e.app == "Google Chrome"]
      assert len(chrome_events) == 1
      assert chrome_events[0].url == "https://github.com/x/y"
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/test_activitywatch.py -v
  ```

  Expected: `ImportError: cannot import name 'ActivityWatchClient'`

- [ ] **Step 3: Implement activitywatch.py**

  `timetrack/activitywatch.py`:
  ```python
  from datetime import datetime, timezone
  import requests

  from .blocks import AWEvent, AFKEvent


  class ActivityWatchClient:
      def __init__(self, base_url: str = "http://localhost:5600"):
          self.base_url = base_url.rstrip("/")
          self._session = requests.Session()

      def _get(self, path: str, **params) -> list | dict:
          resp = self._session.get(
              f"{self.base_url}/api/0{path}", params=params, timeout=10
          )
          resp.raise_for_status()
          return resp.json()

      def is_running(self) -> bool:
          try:
              self._get("/info")
              return True
          except requests.RequestException:
              return False

      def _fetch_events(
          self, bucket_id: str, start: datetime, end: datetime
      ) -> list[dict]:
          return self._get(
              f"/buckets/{bucket_id}/events",
              start=start.isoformat(),
              end=end.isoformat(),
              limit=10000,
          )

      def get_all_events(
          self, start: datetime, end: datetime
      ) -> tuple[list[AWEvent], list[AFKEvent]]:
          """
          Returns (window_events, afk_events).
          Web watcher events replace window watcher events for browser apps.
          """
          buckets: dict = self._get("/buckets")

          web_apps: set[str] = set()
          web_events: list[AWEvent] = []
          afk_events: list[AFKEvent] = []

          # First pass: web watcher (determines which apps it covers)
          for bucket_id in buckets:
              if not bucket_id.startswith("aw-watcher-web"):
                  continue
              for e in self._fetch_events(bucket_id, start, end):
                  ts = datetime.fromisoformat(e["timestamp"]).astimezone(timezone.utc)
                  app = e["data"].get("app", "Browser")
                  web_apps.add(app)
                  web_events.append(AWEvent(
                      timestamp=ts,
                      duration=float(e["duration"]),
                      app=app,
                      title=e["data"].get("title", ""),
                      url=e["data"].get("url"),
                  ))

          # Second pass: window watcher (skip apps covered by web watcher)
          window_events: list[AWEvent] = []
          for bucket_id in buckets:
              if not bucket_id.startswith("aw-watcher-window"):
                  continue
              for e in self._fetch_events(bucket_id, start, end):
                  app = e["data"].get("app", "Unknown")
                  if app in web_apps:
                      continue
                  ts = datetime.fromisoformat(e["timestamp"]).astimezone(timezone.utc)
                  window_events.append(AWEvent(
                      timestamp=ts,
                      duration=float(e["duration"]),
                      app=app,
                      title=e["data"].get("title", ""),
                  ))

          # AFK watcher
          for bucket_id in buckets:
              if not bucket_id.startswith("aw-watcher-afk"):
                  continue
              for e in self._fetch_events(bucket_id, start, end):
                  ts = datetime.fromisoformat(e["timestamp"]).astimezone(timezone.utc)
                  afk_events.append(AFKEvent(
                      timestamp=ts,
                      duration=float(e["duration"]),
                      status=e["data"].get("status", "afk"),
                  ))

          return window_events + web_events, afk_events
  ```

- [ ] **Step 4: Run tests**

  ```bash
  pytest tests/test_activitywatch.py -v
  ```

  Expected: `4 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add timetrack/activitywatch.py tests/test_activitywatch.py
  git commit -m "feat: ActivityWatch REST client with web watcher enrichment"
  ```

---

## Task 6: notion.py — Notion client

**Files:**
- Create: `~/timetrack/timetrack/notion.py`
- Create: `~/timetrack/tests/test_notion.py`

- [ ] **Step 1: Write failing test**

  `tests/test_notion.py`:
  ```python
  from datetime import datetime, timezone
  from zoneinfo import ZoneInfo
  import responses
  import json

  from timetrack.blocks import FocusBlock
  from timetrack.notion import NotionTimeLogClient

  DB_ID = "35b4cfe8-1f3a-457a-80a8-fe61aa465a18"
  TOKEN = "secret_test"
  TZ = ZoneInfo("Europe/Moscow")

  def make_block(url=None) -> FocusBlock:
      return FocusBlock(
          app="Code",
          title="activitywatch.py — timetrack — VS Code",
          start_utc=datetime(2026, 4, 11, 7, 0, 0, tzinfo=timezone.utc),
          end_utc=datetime(2026, 4, 11, 7, 23, 10, tzinfo=timezone.utc),
          active_seconds=1390.0,
          url=url,
      )

  @responses.activate
  def test_create_entry_returns_page_id():
      responses.add(
          responses.POST,
          "https://api.notion.com/v1/pages",
          json={"id": "page-abc-123"},
          status=200,
      )
      client = NotionTimeLogClient(TOKEN, DB_ID)
      page_id = client.create_entry(make_block(), TZ)
      assert page_id == "page-abc-123"

  @responses.activate
  def test_create_entry_payload_includes_required_fields():
      captured = {}

      def capture(request):
          captured["body"] = json.loads(request.body)
          return (200, {}, json.dumps({"id": "page-xyz"}))

      responses.add_callback(
          responses.POST,
          "https://api.notion.com/v1/pages",
          callback=capture,
          content_type="application/json",
      )
      client = NotionTimeLogClient(TOKEN, DB_ID)
      client.create_entry(make_block(), TZ)

      props = captured["body"]["properties"]
      assert props["Entry"]["title"][0]["text"]["content"] == "activitywatch.py — timetrack — VS Code"
      assert "23м" in props["Время"]["rich_text"][0]["text"]["content"]
      assert props["Sorted"]["checkbox"] is False
      assert "Start" in props
      assert "End" in props

  @responses.activate
  def test_create_entry_note_includes_url_when_present():
      captured = {}

      def capture(request):
          captured["body"] = json.loads(request.body)
          return (200, {}, json.dumps({"id": "page-xyz"}))

      responses.add_callback(
          responses.POST,
          "https://api.notion.com/v1/pages",
          callback=capture,
          content_type="application/json",
      )
      client = NotionTimeLogClient(TOKEN, DB_ID)
      client.create_entry(make_block(url="https://github.com/x/y"), TZ)

      note = captured["body"]["properties"]["Note"]["rich_text"][0]["text"]["content"]
      assert "https://github.com/x/y" in note

  @responses.activate
  def test_create_entry_title_truncated_at_100_chars():
      responses.add(
          responses.POST,
          "https://api.notion.com/v1/pages",
          json={"id": "page-abc"},
          status=200,
      )
      long_title_block = FocusBlock(
          app="Code",
          title="x" * 150,
          start_utc=datetime(2026, 4, 11, 7, 0, 0, tzinfo=timezone.utc),
          end_utc=datetime(2026, 4, 11, 7, 5, 0, tzinfo=timezone.utc),
          active_seconds=200.0,
      )
      client = NotionTimeLogClient(TOKEN, DB_ID)
      client.create_entry(long_title_block, TZ)
      req_body = json.loads(responses.calls[0].request.body)
      title = req_body["properties"]["Entry"]["title"][0]["text"]["content"]
      assert len(title) == 100
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  pytest tests/test_notion.py -v
  ```

  Expected: `ImportError: cannot import name 'NotionTimeLogClient'`

- [ ] **Step 3: Implement notion.py**

  `timetrack/notion.py`:
  ```python
  from zoneinfo import ZoneInfo
  from notion_client import Client

  from .blocks import FocusBlock


  class NotionTimeLogClient:
      def __init__(self, token: str, db_id: str):
          self.client = Client(auth=token)
          self.db_id = db_id

      def create_entry(self, block: FocusBlock, tz: ZoneInfo) -> str:
          title = block.title[:100]

          note_parts = [f"App: {block.app}"]
          if block.url:
              note_parts.append(f"URL: {block.url}")
          note = "\n".join(note_parts)

          response = self.client.pages.create(
              parent={"database_id": self.db_id},
              properties={
                  "Entry": {
                      "title": [{"text": {"content": title}}]
                  },
                  "Start": {
                      "date": {"start": block.start_local(tz).isoformat()}
                  },
                  "End": {
                      "date": {"start": block.end_local(tz).isoformat()}
                  },
                  "Время": {
                      "rich_text": [{"text": {"content": f"{block.active_minutes()}м"}}]
                  },
                  "Note": {
                      "rich_text": [{"text": {"content": note}}]
                  },
                  "Sorted": {"checkbox": False},
              },
          )
          return response["id"]
  ```

- [ ] **Step 4: Run tests**

  ```bash
  pytest tests/test_notion.py -v
  ```

  Expected: `4 passed`

- [ ] **Step 5: Commit**

  ```bash
  git add timetrack/notion.py tests/test_notion.py
  git commit -m "feat: Notion Time Log entry creation"
  ```

---

## Task 7: cli.py — sync command

**Files:**
- Create: `~/timetrack/timetrack/cli.py`

This is the integration layer. No separate unit tests — it's tested manually after the full stack is wired up.

- [ ] **Step 1: Implement cli.py**

  `timetrack/cli.py`:
  ```python
  import logging
  import sys
  from datetime import datetime, timedelta, timezone
  from zoneinfo import ZoneInfo

  from .activitywatch import ActivityWatchClient
  from .blocks import compute_focus_blocks
  from .config import load_config
  from .notion import NotionTimeLogClient
  from .state import State

  logging.basicConfig(
      level=logging.INFO,
      format="%(asctime)s %(levelname)s %(message)s",
      datefmt="%Y-%m-%d %H:%M:%S",
  )
  log = logging.getLogger(__name__)


  def sync() -> None:
      cfg = load_config()
      state = State.load()

      aw = ActivityWatchClient(cfg.activitywatch.base_url)
      if not aw.is_running():
          log.warning("ActivityWatch is not running, skipping sync")
          sys.exit(0)

      now = datetime.now(tz=timezone.utc)

      if state.last_sync is None:
          start = now - timedelta(days=cfg.sync.initial_sync_days)
          log.info("First run: syncing last %d days", cfg.sync.initial_sync_days)
      else:
          start = state.last_sync - timedelta(minutes=30)
          log.info("Incremental sync from %s", start.isoformat())

      window_events, afk_events = aw.get_all_events(start, now)
      blocks = compute_focus_blocks(
          window_events,
          afk_events,
          afk_threshold_sec=cfg.activitywatch.afk_threshold_min * 60,
          merge_gap_sec=cfg.activitywatch.merge_gap_sec,
          min_duration_sec=cfg.activitywatch.min_block_duration_sec,
      )
      log.info("Found %d focus blocks in range", len(blocks))

      notion = NotionTimeLogClient(cfg.notion.token, cfg.notion.timelog_db)
      tz = ZoneInfo(cfg.timezone)
      new_count = 0

      for block in blocks:
          sig = block.signature()
          if sig in state.notion_entries:
              continue

          try:
              page_id = notion.create_entry(block, tz)
              state.notion_entries[sig] = page_id
              new_count += 1
          except Exception as exc:
              log.error("Failed to create Notion entry for '%s': %s", block.title, exc)
              state.save()
              sys.exit(1)

      state.last_sync = now
      state.save()
      log.info("Synced %d new entries", new_count)


  def main() -> None:
      if len(sys.argv) < 2 or sys.argv[1] != "sync":
          print("Usage: timetrack sync")
          sys.exit(1)
      sync()
  ```

- [ ] **Step 2: Run all tests**

  ```bash
  pytest -v
  ```

  Expected: all previous tests pass, no new failures.

- [ ] **Step 3: Manual smoke test (requires ActivityWatch running + Notion token in config)**

  ```bash
  # First create config if not done yet:
  mkdir -p ~/.config/timetrack
  cat > ~/.config/timetrack/config.toml << 'EOF'
  timezone = "Europe/Moscow"

  [notion]
  token = "secret_YOUR_TOKEN_HERE"
  timelog_db = "35b4cfe8-1f3a-457a-80a8-fe61aa465a18"

  [activitywatch]
  afk_threshold_min = 10
  min_block_duration_sec = 120
  merge_gap_sec = 180

  [sync]
  initial_sync_days = 1
  EOF

  # Fill in real token, then:
  timetrack sync
  ```

  Expected: log output showing synced entries, new rows appear in Notion Time Log.

- [ ] **Step 4: Commit**

  ```bash
  git add timetrack/cli.py
  git commit -m "feat: sync command — wires AW + focus blocks + Notion"
  ```

---

## Task 8: launchd + install script

**Files:**
- Create: `~/timetrack/com.timetrack.sync.plist`
- Create: `~/timetrack/install.sh`

- [ ] **Step 1: Create launchd plist template**

  `com.timetrack.sync.plist`:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
      <key>Label</key>
      <string>com.timetrack.sync</string>
      <key>ProgramArguments</key>
      <array>
          <string>TIMETRACK_BIN</string>
          <string>sync</string>
      </array>
      <key>StartInterval</key>
      <integer>900</integer>
      <key>StandardOutPath</key>
      <string>LOG_DIR/sync.log</string>
      <key>StandardErrorPath</key>
      <string>LOG_DIR/sync.log</string>
      <key>RunAtLoad</key>
      <true/>
  </dict>
  </plist>
  ```

- [ ] **Step 2: Create install.sh**

  `install.sh`:
  ```bash
  #!/bin/bash
  set -e

  INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
  VENV_DIR="$INSTALL_DIR/.venv"
  LOG_DIR="$HOME/Library/Logs/timetrack"
  CONFIG_DIR="$HOME/.config/timetrack"
  PLIST_SRC="$INSTALL_DIR/com.timetrack.sync.plist"
  PLIST_DST="$HOME/Library/LaunchAgents/com.timetrack.sync.plist"

  echo "Creating venv and installing timetrack..."
  python3.11 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install -q -e "$INSTALL_DIR"

  echo "Creating log directory..."
  mkdir -p "$LOG_DIR"

  echo "Creating config directory..."
  mkdir -p "$CONFIG_DIR"

  if [ ! -f "$CONFIG_DIR/config.toml" ]; then
      cat > "$CONFIG_DIR/config.toml" << 'EOF'
  timezone = "Europe/Moscow"  # Change to your IANA timezone

  [notion]
  token = "YOUR_NOTION_INTEGRATION_TOKEN"
  timelog_db = "35b4cfe8-1f3a-457a-80a8-fe61aa465a18"

  [activitywatch]
  base_url = "http://localhost:5600"
  afk_threshold_min = 10
  min_block_duration_sec = 120
  merge_gap_sec = 180

  [sync]
  initial_sync_days = 7
  EOF
      echo "⚠️  Config created at $CONFIG_DIR/config.toml"
      echo "   Fill in your Notion integration token before first sync."
  fi

  echo "Installing launchd service..."
  sed -e "s|TIMETRACK_BIN|$VENV_DIR/bin/timetrack|g" \
      -e "s|LOG_DIR|$LOG_DIR|g" \
      "$PLIST_SRC" > "$PLIST_DST"

  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl load "$PLIST_DST"

  echo "✓ timetrack installed. Syncs every 15 min."
  echo "  Logs: $LOG_DIR/sync.log"
  ```

- [ ] **Step 3: Make executable and test**

  ```bash
  chmod +x ~/timetrack/install.sh
  cd ~/timetrack && bash install.sh
  ```

  Expected: service loads, `launchctl list | grep timetrack` shows `com.timetrack.sync`.

- [ ] **Step 4: Verify service runs**

  ```bash
  tail -f ~/Library/Logs/timetrack/sync.log
  ```

  Expected within 1 min: log lines from timetrack sync.

- [ ] **Step 5: Commit**

  ```bash
  git add com.timetrack.sync.plist install.sh
  git commit -m "feat: launchd install script (15-min sync service)"
  ```

---

## Task 9: Claude Code scheduled task — daily AI classification

This task sets up the daily Claude Code scheduled task that classifies unsorted Time Log entries.

- [ ] **Step 1: Open Claude Code and run /schedule**

  In Claude Code (desktop or CLI), run:

  ```
  /schedule
  ```

- [ ] **Step 2: Configure the scheduled task**

  When prompted, provide:

  - **Schedule:** `0 23 * * *` (daily at 23:00)
  - **Prompt:**

  ```
  You have access to Notion via MCP tools.

  Your job: classify today's unprocessed time log entries by matching them to active tasks.

  Steps:
  1. Query the Time Log database (ID: 35b4cfe8-1f3a-457a-80a8-fe61aa465a18) for ALL entries where Sorted = false.
  2. Query the Tasks database (ID: 283efefe-7621-47ce-9f0e-7c9f3065ab78) for all tasks where done = "Not started" or "In progress".
  3. For EACH Time Log entry:
     - Read its Entry field (window title) and Note field (app name, URL if any).
     - Find the best-matching Task based on semantic similarity (project name, topic, keywords in title/URL).
     - If a reasonable match exists (confidence > 60%), set the Task relation to that task.
     - If no match: leave Task empty.
     - Always set Sorted = true.
  4. Process ALL entries — do not stop until every Sorted=false entry has been handled.
  5. At the end, print a summary: N entries processed, M matched to tasks, K left unmatched.
  ```

- [ ] **Step 3: Verify the task appears in schedule list**

  ```
  /schedule list
  ```

  Expected: task listed with cron `0 23 * * *`.

- [ ] **Step 4: Test with a dry run (optional)**

  Manually trigger the task once to verify it works with real data:

  ```
  /schedule run <task-id>
  ```

  Check Notion Time Log — entries should have `Sorted = true` and some should have `Task` relation set.

- [ ] **Step 5: Final commit**

  ```bash
  cd ~/timetrack
  git add .
  git commit -m "docs: add scheduled task setup instructions"
  ```

---

## Self-Review

**Spec coverage check:**
- ✅ ActivityWatch REST API with dynamic bucket discovery → `activitywatch.py`
- ✅ AFK filtering (10 min threshold) → `blocks.py`
- ✅ Focus block algorithm (merge gap 3 min, min 2 min) → `blocks.py`
- ✅ Browser URL enrichment via aw-watcher-web → `activitywatch.py`
- ✅ Deduplication via signature + state.json → `cli.py` + `state.py`
- ✅ Initial sync (initial_sync_days) → `cli.py`
- ✅ 30-min overlap on incremental sync → `cli.py`
- ✅ `Время` field written as `{N}м` → `notion.py`
- ✅ `Sorted` = false on creation → `notion.py`
- ✅ Window title in Entry, app + URL in Note → `notion.py`
- ✅ AW not running → exit 0 (launchd won't restart) → `cli.py`
- ✅ Notion error → preserve state, exit 1 → `cli.py`
- ✅ launchd plist (15 min, StartInterval=900) → Task 8
- ✅ Claude Code scheduled task (daily 23:00, Sorted=false filter) → Task 9

**Type consistency check:**
- `AWEvent`, `AFKEvent`, `FocusBlock` defined in `blocks.py` and used consistently in `activitywatch.py`, `notion.py`, `cli.py` ✅
- `compute_focus_blocks` signature matches calls in `cli.py` ✅
- `State.load()` / `state.save()` consistent throughout ✅
- `NotionTimeLogClient.create_entry(block, tz)` matches definition ✅
