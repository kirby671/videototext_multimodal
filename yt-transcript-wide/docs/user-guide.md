# User guide

## On YouTube

Open any video. The **Clean transcript** panel is pinned to the right of the window, as wide as YouTube's sidebar.

- **Get transcript** briefly opens YouTube's own transcript panel, reads it, closes it again, and shows a clean
  version: no timestamps, no `[Music]`/`[Applause]`, no "um/uh" or stutters. It's free and needs no API key.
- **Analyze with Claude** identifies the speakers and builds the insights in one call: summary, themes, concepts
  explained step by step, how the speakers do things and see things, strong statements, facts & figures, every
  company mentioned with a note on why, and a concept map. The first time, it asks you to add your Anthropic API key.
- **Translate [language]** translates the transcript. It uses Chrome's built-in translator, which runs on your
  computer for free (Chrome downloads the model for each language pair once). If Chrome's translator can't run, you're
  offered **Translate with Claude Haiku**, with its estimated cost on the button. Click **Show original** to switch back.
- Tabs: **Transcript · Insights · Companies**. Click a highlighted company to jump to its glossary entry, or a
  _Concept_ tag to jump to its breakdown. Double-click a paragraph to jump the video to that moment.

**Resizing.** Drag the panel's left edge to widen it; double-click the edge (or press Enter on it) to go back to the
sidebar width. Each new video opens at the sidebar width. The ⤡ button turns the panel into a card above the
recommendations instead; clicking the title folds it away.

**Cost.** After each Claude run the panel shows what it cost (from the token counts Claude reports, at Anthropic's list
prices). The line at the bottom shows the total for this video and overall. Re-opening a video you've already analyzed
is free: everything is kept in your Library.

## Any transcript

Click the toolbar icon on any page that isn't a YouTube video, or **Paste a transcript** on the panel, and paste text
such as a transcript copied from YouTube. You can also select transcript text on any page, right-click, and choose
**Clean & analyze this transcript**.

**No API key?** Cleaning, translating with Chrome, and the Library all work without one. **Copy prompt for claude.ai**
copies the transcript with the full set of instructions, ready to paste into a Claude chat.

## Library

Open it from the books icon on the panel, the **Library** link, or by right-clicking the toolbar icon.

- Search finds words in titles, channels and anything said in a transcript, with a snippet showing where.
- Click a transcript to read it with its Insights and Companies tabs, analyze or translate it, copy it, download it as
  Markdown, open the video, or delete it.
- **Download all** saves every transcript (or just the ones your search shows) as Markdown, as one file or a ZIP with one
  file per video. **Choose…** lets you pick; **Options** chooses what to include.
- **Sync to a folder** keeps your whole Library as Markdown files in a folder you choose (one file per video, an index,
  your latest trend report and company network), so you can add the folder to a Claude chat and ask about it. Only
  files the sync created are ever changed or removed.
- The Library lives in this browser's extension storage, and removing the extension deletes it. Use **Export backup**
  now and then; **Import backup** restores it here or in another browser.

### Trends

Looks across everything you've saved: how many videos over time, which companies come up and when, and the people who
appear most. All of this is free. **Write the trend report** sends the saved analyses (not the full transcripts) of the
videos in range to Claude in one call and reports recurring themes, what's emerging or fading, shifts in views,
agreements and disagreements, company stories and numbers over time. Every claim links back to its videos. The button
shows an estimate first. Each theme can be downloaded as a PDF with the transcripts it cites.

### Network

Shows how the companies in your videos relate to each other: partnerships, who provides what to whom, competition,
investments and acquisitions. **Update network** reads each analyzed video once (later updates only read new or
changed videos) and shows how many and an estimated cost first. Click a company to focus on it, drag to rearrange,
scroll to zoom. **All ties as a list** and **Download .md** export everything.

## Settings

- **Anthropic API key**: stored only in this browser and sent only to `api.anthropic.com`. **Test** checks it.
- **Model**: Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5 (faster and cheaper), or Fable 5.1.
- **Language for Claude's analysis**: insights, themes, companies and trend reports are written in this language,
  whatever language the video is in.
- **What matters most to you**: sent with every analysis to steer what gets pulled out.
- Cleaning options, fetching the transcript automatically when a video opens, and the running cost total.

## Good to know

- Speaker identification is inferred from the text, so it can be wrong where one person's sentence runs into another's.
  Uncertain speakers show their confidence on hover.
- If a video has no captions there's no transcript to fetch; paste one instead.
- If YouTube changes its page layout, the paste route keeps working.
- PDFs use the standard PDF fonts, so characters outside Western European languages print as "?".
