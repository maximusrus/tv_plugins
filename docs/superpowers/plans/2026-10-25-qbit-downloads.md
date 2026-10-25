# qBittorrent downloads implementation plan

Goal: confirm submissions and show a read-only downloads activity in Lampa, as approved in chat.
Architecture: reuse native authenticated requests, register a Lampa activity and menu entry, poll only while active. No dependencies or download-management actions.

- [x] Add bounded confirmation by returned hash / magnet hash; for pending HTTP links compare exact renamed title against a pre-send snapshot. Never confirm an unrelated newly added torrent.
- [x] Add remote-friendly downloads activity: name, status, progress, speed, ETA; active before finished; refresh button and five-second refresh while visible; preserve focus and show stale/error state.
- [x] Test delayed and duplicate submissions, invalid responses, status mapping, sorting and screen lifecycle. Update README.
- [ ] Verify real qBittorrent, publish to main and GitHub Pages, restart TV and verify navigation and list.
