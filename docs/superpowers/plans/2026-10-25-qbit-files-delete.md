# Delete and select files

User-approved scope: delete torrent / torrent with files from downloads; select episodes before download.

- [x] Row action menu, Cancel-first confirmation with torrent name, exact hash validation, no retry on destructive request, verify disappearance.
- [x] Use qBittorrent 5.3 fetchMetadata without adding to transfer list. Checkbox file picker; no file preselected; explicit Download selected. Pass complete filePriorities vector at add time. Cancel leaves no download. Full-download option preserved. No silent fallback on older servers or expired metadata.
- [x] Tests: cancellation, both deletion modes, malformed hashes, delayed/failed metadata, priorities, duplicate torrents, escaping. Live disposable two-file torrent; no user files touched by verification.
- [x] Publish and verify deletion menus and Cancel-first confirmation on TV.

Live server: metadata fetched without payload or transfer-list entry; selected file priorities [0,1], webseed bytes [0,16384]. Both delete modes verified by re-add/recheck (retained bytes vs zero bytes). Test torrent cleaned up.

TV: row actions and destructive confirmation rendered correctly; Cancel preserved the user torrent. Series picker requires a physical long OK; user confirmation requested. Magnet metadata flow also verified against the live server without changing its transfer list.
