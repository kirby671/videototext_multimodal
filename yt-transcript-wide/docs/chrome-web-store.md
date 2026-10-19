# Chrome Web Store listing

Everything the Developer Dashboard asks for, ready to paste. Build the upload with `npm run build`
(see the [README](../README.md#building-for-the-chrome-web-store)).

## Before the first submission

- [ ] Add a support email to [PRIVACY.md](../PRIVACY.md) and publish it at a public URL. If this repository is
      public, the file's GitHub URL works; otherwise use a public Gist or a Google Doc published to the web.
- [ ] Register at the Chrome Web Store Developer Dashboard (one-time fee). Use a dedicated email address (it can't be
      changed later) and choose a publisher name you're happy to be public.
- [ ] Declare **non-trader** unless you sell something; traders must show contact details to EU users.
- [ ] If an API key was ever committed to this repository's history, rotate it at console.anthropic.com.
- [ ] Publish as **Unlisted** first and install from the link to test, then switch to **Public**.

## Store listing

**Name:** Clean Transcript & Key Learnings for YouTube

**Summary** (from `manifest.json`, 128/132 characters): Clean, speaker-grouped YouTube transcripts with Claude's key
learnings, concepts and company glossary, kept in your own Library.

**Category:** Productivity

**Description:**

> Turn any YouTube video, or any transcript you paste, into something you can actually use.
>
> • Clean transcript: timestamps, [Music], "um/uh" and stutters removed
> • Speakers identified and grouped, with misheard names fixed
> • Key themes, learnings, strong statements and concepts explained step by step
> • Companies highlighted, with a glossary of why each came up
> • Translate the transcript into 39 languages, free with Chrome's built-in translator
> • Get the insights written in your language, whatever language the video is in
> • A Library of everything you've saved, with search, Markdown/PDF export, trend reports across videos and a company
> network map
>
> Getting, cleaning, translating and saving transcripts works right away, for free. To analyze with Claude, add your
> own Anthropic API key the first time you click "Analyze with Claude". It's stored locally in your browser, analysis
> runs on your own account (typically 10–20¢ per hour of video), and you see what each run costs.
>
> Privacy: your Library stays in your browser. Transcript text is sent to Anthropic's API, with your key, only when you
> run a Claude feature. No analytics, no tracking, no servers.

**Graphics:** at least one 1280×800 screenshot (the panel on a public video; no personal tabs, bookmarks or API key in
view), a 440×280 promo tile (recommended), and the 128×128 icon from `icons/icon128.png`.

## Privacy practices

**Single purpose:** Turns YouTube video transcripts (or pasted transcripts) into clean, speaker-grouped text with
optional AI-generated key learnings and translation, kept in a personal Library in the browser.

**Permission justifications** (store builds don't request `alarms`; it's only used by the development auto-reload):

| Permission                    | Justification                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `storage`                     | Saves the user's settings, their Anthropic API key and their transcript Library locally.                                 |
| `unlimitedStorage`            | The Library keeps full transcripts, analyses and translations, which can exceed the default quota.                       |
| `contextMenus`                | "Clean & analyze this transcript" for selected text, and "Open your Library" / "Paste a transcript" on the toolbar icon. |
| `scripting`                   | After install or update, re-injects the extension's own content scripts into YouTube tabs that are already open.         |
| `offscreen`                   | A short-lived hidden page writes the Library to a folder the user chose ("Sync to a folder").                            |
| `https://www.youtube.com/*`   | Shows the transcript panel on watch pages, reads the transcript YouTube loads, looks up publish dates.                   |
| `https://api.anthropic.com/*` | Sends text to Claude with the user's own key when they run a Claude feature.                                             |

**Remote code:** No, I am not using remote code. (All code ships in the package; pdf-lib is bundled in `vendor/`.)

**Data usage:**

- ☑ **Website content**: transcript text and video details are sent to Anthropic when the user runs a Claude feature.
- ☑ **Authentication information**: the user's own Anthropic API key is stored locally and sent only to Anthropic.
- Certify all three: no selling or transferring data outside the approved use cases; no use unrelated to the single
  purpose; no use for creditworthiness or lending.

**Privacy policy URL:** the published copy of [PRIVACY.md](../PRIVACY.md).
