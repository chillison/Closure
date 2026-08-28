import { useState, useEffect, useCallback, useRef } from 'react';

export type TypewriterOptions = {
  /**
   * dogfood T1 CR-T1-040：真禁开关。streaming 消息的 growing content 喂进本 hook 会
   * targetText 每变一次 index 归零 → rAF 全程空转 + 终帧后按 15ms/字追平全文的废弃
   * 时钟。`enabled:false` 时 hook 完全静止（displayedText = 全文、isAnimating=false），
   * 渲染层改走 250ms MD 快照轨（AgentMessageItem 的 snapshotActive 独立启动，不依赖
   * 本 hook 的 isAnimating）。
   */
  enabled?: boolean;
};

export function useTypewriter(targetText: string, speed = 15, options?: TypewriterOptions) {
  const enabled = options?.enabled !== false;
  const [index, setIndex] = useState(0);
  const skipRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      // 禁用时 index 恒贴全文长度（displayedText = 全文、isAnimating = false）——
      // 不归零、不起 rAF（旧实现 streaming 下每 flush setIndex(0) 是空转源头）。
      setIndex(targetText.length);
      return;
    }
    setIndex(0);
    skipRef.current = false;
    lastTimeRef.current = 0;
  }, [targetText, enabled]);

  useEffect(() => {
    if (!enabled || index >= targetText.length) return;
    if (skipRef.current) {
      setIndex(targetText.length);
      return;
    }

    const step = (time: number) => {
      if (skipRef.current) {
        setIndex(targetText.length);
        return;
      }
      if (!lastTimeRef.current) lastTimeRef.current = time;
      const elapsed = time - lastTimeRef.current;
      if (elapsed >= speed) {
        const charsToAdd = Math.min(Math.floor(elapsed / speed), targetText.length - index);
        setIndex((prev) => Math.min(prev + charsToAdd, targetText.length));
        lastTimeRef.current = time;
      }
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [index, targetText, speed, enabled]);

  const skip = useCallback(() => {
    skipRef.current = true;
    setIndex(targetText.length);
  }, [targetText]);

  return {
    displayedText: enabled ? targetText.slice(0, index) : targetText,
    isAnimating: enabled && index < targetText.length,
    skip,
  };
}
