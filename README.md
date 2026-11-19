# sky-music

Music timelines for the gooey visualizer on my portfolio's music player.

For every song the site's radio plays, `scripts/build.mjs` measures how loud
its bass, mids and highs are, 20 times a second for the whole song, plus its
tempo. The site fetches one small file for the song that is playing and the
visualizer moves with it.

## What is here

- `data/v/<youtube-video-id>.json`: one song's timeline (10 to 25 KB).
  `low`, `mid` and `high` are base64 byte arrays, one value (0 to 255) per
  frame at `fps` frames a second, scaled from the song's quiet floor to its
  loud ceiling. `bpm` is its tempo.
- `data/tracks.json`: Spotify track id to YouTube video id, the recording each
  playlist song was measured from. The site's radio plays these recordings, so
  a timeline always matches what is heard.

No audio is kept: each song is streamed through ffmpeg and only the numbers
are written.

## Running it

Needs `yt-dlp` and `ffmpeg` (`brew install yt-dlp ffmpeg`), and the site
running (it reads the playlist and visitors' songs from the site's API).

```sh
SITE_URL=http://localhost:3100 npm run build
```

Only songs without a timeline are processed, so later runs only pick up new
songs. Commit and push `data/`; the site reads it through jsDelivr
(`cdn.jsdelivr.net/gh/gelogonza/sky-music@main/data`), which can take a while
to refresh a cached file.

`node scripts/build.mjs --test <video-id>` measures one video and prints its
tempo, length and file size, without writing anything.
