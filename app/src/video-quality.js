(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JiutianVideoQuality = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  function positive(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; }
  function fraction(value) {
    if (typeof value === 'string' && value.includes('/')) { const [a,b] = value.split('/').map(Number); return b ? positive(a/b) : 0; }
    return positive(value);
  }
  function codecName(value) {
    const text = String(value || '').toLowerCase();
    if (/h\.?264|avc/.test(text)) return 'h264';
    if (/h\.?265|hevc/.test(text)) return 'hevc';
    if (/av01|av1/.test(text)) return 'av1';
    if (/vp09|vp9/.test(text)) return 'vp9';
    return text;
  }
  function metrics(entry = {}) {
    const width = positive(entry.width || entry.vwidth);
    const height = positive(entry.height || entry.vheight);
    const definition = String(entry.definition || entry.quality || '').toLowerCase();
    const nominal = ({'4k':2160,'uhd':2160,'2k':1440,'fhd':1080,'hd':720,'sd':480})[definition] || positive(definition.match(/^(\d{3,4})p$/)?.[1]);
    return {width, height, pixels: width && height ? width*height : nominal ? nominal*nominal*16/9 : 0,
      bitrate: positive(entry.bit_rate || entry.bitrate || entry.real_bitrate),
      codec: codecName(entry.codec_name || entry.codec || entry.codec_type_name || entry.vcodec),
      fps: fraction(entry.avg_frame_rate || entry.fps || entry.frame_rate),
      original: /original_media_info|original_video_info|original_url|origin_url/.test(`${entry.source || ''} ${entry.path || ''}`) ? 1 : 0};
  }
  // Sort only versions of the SAME video. Codec preference is deterministic;
  // bitrate is comparable within one known codec, not across different codecs.
  function compare(a, b) {
    const x = metrics(a), y = metrics(b);
    if (x.pixels !== y.pixels) return y.pixels-x.pixels;
    if (x.original !== y.original) return y.original-x.original;
    const compatibility = { h264:4, hevc:3, av1:2, vp9:1 };
    if (x.codec !== y.codec) return (compatibility[y.codec] || 0) - (compatibility[x.codec] || 0) || x.codec.localeCompare(y.codec);
    if (x.codec && x.bitrate !== y.bitrate) return y.bitrate-x.bitrate;
    return y.fps-x.fps;
  }
  function sorted(entries) { return [...entries].filter(e => e && typeof e === 'object').sort(compare); }
  function format(info) {
    if (!info || info.status === 'pending') return '正在检测文件画质…';
    if (info.status !== 'ready') return info.message || '画质暂不可读取';
    const parts = [`${info.width} × ${info.height}`];
    if (info.fps) parts.push(`${Number(info.fps.toFixed(2))} fps`);
    if (info.videoBitrate) parts.push(`${(info.videoBitrate/1e6).toFixed(2)} Mbps`);
    else if (info.totalBitrate) parts.push(`总码率 ${(info.totalBitrate/1e6).toFixed(2)} Mbps`);
    if (info.codec) parts.push(info.codec.toUpperCase());
    return parts.join(' · ');
  }
  return {metrics,compare,sorted,fraction,format};
});
