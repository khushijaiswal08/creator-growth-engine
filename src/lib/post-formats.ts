/** The kinds of post a person can record, as the form offers them. The key is what is stored on the Post. */
export const POST_FORMATS = [
  ["reel", "Reel"],
  ["story", "Story"],
  ["post", "Feed post"],
  ["carousel", "Carousel"],
  ["video", "Video (YouTube / TikTok)"],
  ["short", "Short"],
  ["pin", "Pin"],
] as const;

type PostFormat = (typeof POST_FORMATS)[number][0];

export const isPostFormat = (value: string): value is PostFormat => POST_FORMATS.some(([key]) => key === value);
