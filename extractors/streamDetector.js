function isStream(url) {
  return /\.(m3u8|mp4|mpd|mkv|webm)(\?|$)/i.test(url);
}

module.exports = { isStream };
