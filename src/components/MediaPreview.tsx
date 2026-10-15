import { ImageOff, Play } from "lucide-react";
import { useEffect, useState } from "react";

import type { Item } from "../types";
import { galleryOf, playableVideo, thumbnailOf } from "../lib/media";

/** Picture gallery and video player for the top of a memo. Renders nothing when there is no media. */
export function MediaPreview({ item }: { item: Item }) {
  const gallery = galleryOf(item);
  const video = playableVideo(item);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  // A different memo starts from its first picture with the video stopped.
  useEffect(() => {
    setSelected(0);
    setPlaying(false);
    setVideoFailed(false);
    setFailed(new Set());
  }, [item.id]);

  const pictures = gallery.filter((url) => !failed.has(url));
  const markFailed = (url: string) => setFailed((current) => new Set(current).add(url));
  const poster = thumbnailOf(item);

  if (!video && !gallery.length) return null;

  return (
    <section className="media" aria-label="미리보기">
      {video?.kind === "file" && !videoFailed && (
        <video
          className="media-main"
          src={video.url}
          poster={poster || undefined}
          controls
          playsInline
          preload="metadata"
          onError={() => setVideoFailed(true)}
        />
      )}

      {video?.kind === "youtube" &&
        (playing ? (
          <div className="media-main media-frame">
            <iframe
              title="영상 미리보기"
              src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        ) : (
          <button type="button" className="media-main media-poster" onClick={() => setPlaying(true)} aria-label="영상 재생">
            {poster && <img src={poster} alt="" referrerPolicy="no-referrer" />}
            <span className="play-badge">
              <Play size={28} />
            </span>
          </button>
        ))}

      {video?.kind === "file" && videoFailed && (
        <p className="media-note">
          <ImageOff size={16} /> 이 영상은 앱 안에서 재생할 수 없어요. 원본 링크에서 확인해 주세요.
        </p>
      )}

      {!video && pictures.length > 0 && (
        <a className="media-main media-image" href={pictures[Math.min(selected, pictures.length - 1)]} target="_blank" rel="noopener noreferrer">
          <img
            src={pictures[Math.min(selected, pictures.length - 1)]}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => markFailed(pictures[Math.min(selected, pictures.length - 1)])}
          />
        </a>
      )}

      {pictures.length > 1 && (
        <div className="media-strip" role="list">
          {pictures.map((url, index) => (
            <button
              type="button"
              role="listitem"
              key={url}
              className={index === selected && !video ? "active" : ""}
              onClick={() => {
                setSelected(index);
                setPlaying(false);
              }}
              aria-label={`사진 ${index + 1}`}
            >
              <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => markFailed(url)} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
