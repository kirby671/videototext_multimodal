# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.16.1] - 2026-10-19

### Fixed

- In the pinned YouTube panel, a status message that wrapped onto several lines (for example after an analysis) overlapped
  the Transcript / Insights / Companies tabs. The controls now keep their full height and only the transcript area
  shrinks; on very short windows the panel scrolls.

## [1.16.0] - 2026-10-19

### Changed

- Reorganized the codebase: `src/` split into `background`, `content`, `core`, `ui`, `features` and `pages`;
  third-party code moved to `vendor/`; page styles moved into their own stylesheets. `manifest.json` stays at the
  root so existing unpacked installs keep their extension ID and Library.
- Formatted with Prettier and linted with ESLint.
- Content scripts re-injected after an update are now read from the manifest instead of a duplicated list.

### Added

- `npm run build`: Web Store package with dev-only code and permissions stripped, a broken-reference check and a
  credentials/personal-data scan.
- Unit tests for the core logic and build steps (`node:test`), and a CI workflow.
- README with architecture and development docs, user guide, privacy policy and Chrome Web Store listing doc.

## [1.15.1] - 2026-10-19

### Changed

- A translation now shows one message ("Showing Chinese, translated from English, for free by Chrome on your
  computer.") instead of two.

## [1.15.0] - 2026-10-19

### Changed

- **Translate** moved next to **Analyze with Claude**; one button toggles between the translation and the original.
- The YouTube panel opens at sidebar width on every video. Drag its edge to widen it; double-click to reset.

### Removed

- The **Distill transcript** button. Transcripts distilled earlier can still be viewed.

## [1.14.1] - 2026-10-19

### Fixed

- Translation stopped with "Couldn't tell which language the transcript is in" when Chrome's language detector
  wasn't ready. The language is now detected offline from the text first.
- Chrome's translator could wait forever when its model couldn't download; it now falls back after 45 seconds.

## [1.14.0] - 2026-10-19

### Added

- **Language for Claude's analysis** setting: insights, trend reports and copied prompts in any of 39 languages.
- **Translate** the transcript with Chrome's built-in on-device translator (free), with Claude Haiku as an opt-in
  fallback that shows its cost first. Translations are saved in the Library.

## [1.13.0] - 2026-10-19

### Changed

- Basic features work without an API key. The key is asked for only when a Claude feature is used, from a prompt in the
  panel; the key itself is entered on the Settings page, never on YouTube.

## [1.12.0] - 2026-10-19

### Added

- First-run prompts for an API key (replaced by the on-demand prompt in 1.13.0).

## [1.11.0]

- Baseline: clean transcripts, Claude analysis, Library with Trends and Network, exports, folder sync.
