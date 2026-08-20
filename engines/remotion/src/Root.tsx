import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { Assemble } from "./Assemble";
import {
  manifestSchema,
  totalDurationInFrames,
  type Manifest,
} from "./manifest";
import { Poster } from "./Poster";
import {
  POSTER_DIMENSIONS,
  posterSchema,
  type PosterProps,
} from "./posterManifest";
import { Thumbnail } from "./Thumbnail";
import {
  THUMBNAIL_DIMENSIONS,
  thumbnailSchema,
  type ThumbnailProps,
} from "./thumbnailManifest";

/**
 * Manifest demo tối thiểu — chỉ để mở `remotion studio` mà không cần props.
 * Không có `render`/`srcVideo` nên SceneClip hiện placeholder, không đòi file
 * trong public/staging. Render thật luôn truyền --props=<props.resolved.json>.
 */
const demoManifest: Manifest = {
  id: "demo-gioi-thieu",
  name: "Demo giới thiệu hệ thống",
  width: 1080,
  height: 1920,
  fps: 30,
  status: "draft",
  scenes: [
    { id: "s01-logo", src: "compositions/s01-logo.html", durationInFrames: 90, srcImage: null },
    { id: "s02-tagline", src: "compositions/s02-tagline.html", durationInFrames: 120, srcImage: null },
  ],
  audio: { sfx: [], music: null },
  captions: [],
  overlays: [],
  // Demo không có phụ đề dịch - `subtitles` có default [] khi parse, nhưng
  // literal này khai theo KIỂU ĐÃ PARSE nên phải ghi đủ trường.
  subtitles: [],
  // Studio demo không có file logo trong public/ - để null, còn render thật thì
  // server tự chèn từ Style Design (xem jobs/assemble.ts)
  watermark: null,
  output: null,
};

/**
 * width/height/fps/durationInFrames lấy từ manifest (không hardcode).
 * Parse qua zod: fail sớm với message rõ ràng nếu props sai schema,
 * đồng thời áp default (audio.sfx = []).
 */
const calculateAssembleMetadata: CalculateMetadataFunction<Manifest> = ({
  props,
}) => {
  const manifest = manifestSchema.parse(props);
  return {
    props: manifest,
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    durationInFrames: totalDurationInFrames(manifest),
  };
};

/**
 * Poster demo — chỉ để mở studio không cần props. background/logoFile null
 * nên không đòi file trong public/staging. Render thật luôn --props=<file>.
 */
const demoPoster: PosterProps = posterSchema.parse({
  aspect: "9:16",
  background: null,
  overlay: {
    title: "Tự Động Hóa Marketing Bằng AI",
    subtitle: "Tiết kiệm 80% thời gian edit video",
    stats: [
      { label: "Video/tháng", value: "120+" },
      { label: "Chi phí giảm", value: "65%" },
    ],
    cta: "Dùng thử miễn phí",
    showLogo: true,
  },
  design: { brandName: "AIEV - Mr Hoàng" },
});

/**
 * Still 1 frame — width/height suy từ props.aspect (docs/API.md):
 * 9:16=1080×1920, 16:9=1920×1080, 1:1=1080×1080, 4:5=1080×1350.
 */
const calculatePosterMetadata: CalculateMetadataFunction<PosterProps> = ({
  props,
}) => {
  const poster = posterSchema.parse(props);
  const { width, height } = POSTER_DIMENSIONS[poster.aspect];
  return {
    props: poster,
    width,
    height,
    fps: 30,
    durationInFrames: 1,
  };
};

/**
 * Thumbnail demo — background/frame null nên mở studio được mà không cần
 * file trong public/staging. Render thật luôn --props=<file>.
 */
const demoThumbnail: ThumbnailProps = thumbnailSchema.parse({
  aspect: "9:16",
  background: null,
  frame: null,
  title: "Video này Edit bằng AI",
  design: { brandName: "AIEV - Mr Hoàng" },
});

/** Still 1 frame — width/height suy từ props.aspect (giống Poster). */
const calculateThumbnailMetadata: CalculateMetadataFunction<ThumbnailProps> = ({
  props,
}) => {
  const thumb = thumbnailSchema.parse(props);
  const { width, height } = THUMBNAIL_DIMENSIONS[thumb.aspect];
  return { props: thumb, width, height, fps: 30, durationInFrames: 1 };
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Assemble"
        component={Assemble}
        // Giá trị fallback — calculateMetadata ghi đè từ manifest thật.
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={210}
        defaultProps={demoManifest}
        calculateMetadata={calculateAssembleMetadata}
      />
      <Composition
        id="Poster"
        component={Poster}
        // Fallback — calculateMetadata ghi đè theo props.aspect.
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={1}
        defaultProps={demoPoster}
        calculateMetadata={calculatePosterMetadata}
      />
      <Composition
        id="Thumbnail"
        component={Thumbnail}
        // Fallback — calculateMetadata ghi đè theo props.aspect.
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={1}
        defaultProps={demoThumbnail}
        calculateMetadata={calculateThumbnailMetadata}
      />
    </>
  );
};
