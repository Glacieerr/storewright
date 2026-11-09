/** 类型声明：scripts/media/make-webp.mjs（把静态 WebP 帧拼成动画 WebP） */
export function animatedWebp(frames: readonly { data: Buffer; ms: number }[], opts?: { loop?: number; background?: number }): Buffer;
