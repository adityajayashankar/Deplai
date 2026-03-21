'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { gsap } from 'gsap';
import { SplitText as GSAPSplitText } from 'gsap/SplitText';
import { EnterIcon } from '@/components/log-in-out';
import Link from 'next/link';

gsap.registerPlugin(GSAPSplitText);

// ── Types ─────────────────────────────────────────────────────────────────────

// idle     → arrow icon visible
// entering → SplitText chars animating in (button disabled)
// active   → text fully visible, button enabled
// exiting  → SplitText chars reversing out (button disabled)
// loading  → shiny shimmer playing while auth redirects
type AnimState = 'idle' | 'entering' | 'active' | 'exiting' | 'loading';

interface LandingTextAnimationProps {
  href: string;
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

const LandingTextAnimation: React.FC<LandingTextAnimationProps> = ({
  href,
  className = '',
}) => {
  const [, forceRender] = useState(0);
  const stateRef = useRef<AnimState>('idle');
  const textRef = useRef<HTMLSpanElement>(null);
  const isHoveredRef = useRef(false);

  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const shinyTweenRef = useRef<gsap.core.Tween | null>(null);
  const splitRef = useRef<GSAPSplitText | null>(null);

  const setAnimState = useCallback((s: AnimState) => {
    stateRef.current = s;
    forceRender(n => n + 1);
  }, []);

  const cleanup = useCallback(() => {
    timelineRef.current?.kill();
    timelineRef.current = null;
    shinyTweenRef.current?.kill();
    shinyTweenRef.current = null;
    try { splitRef.current?.revert(); } catch (_) {}
    splitRef.current = null;
  }, []);

  // Hard-reset to idle — clears all GSAP state and stale inline styles
  const resetToIdle = useCallback(() => {
    cleanup();
    const el = textRef.current;
    if (el) {
      el.style.cssText = '';
      el.style.display = 'none';
    }
    stateRef.current = 'idle';
    isHoveredRef.current = false;
    forceRender(n => n + 1);
  }, [cleanup]);

  // ── Shiny effect helpers ──────────────────────────────────────────────────

  const applyShiny = useCallback(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.backgroundImage =
      'linear-gradient(120deg, #b5b5b5 0%, #b5b5b5 35%, #ffffff 50%, #b5b5b5 65%, #b5b5b5 100%)';
    el.style.backgroundSize = '200% auto';
    el.style.webkitBackgroundClip = 'text';
    el.style.backgroundClip = 'text';
    (el.style as any).webkitTextFillColor = 'transparent';
    shinyTweenRef.current = gsap.fromTo(
      el,
      { backgroundPosition: '150% center' },
      { backgroundPosition: '-50% center', duration: 2, ease: 'none', repeat: -1 }
    );
  }, []);

  // ── Build the single reusable timeline (chars split) ──────────────────────
  //    .play()    → entry animation
  //    .reverse() → exit animation (same chars, reversed order)

  const buildTimeline = useCallback(() => {
    const el = textRef.current;
    if (!el) return null;

    cleanup();

    el.style.display = 'inline-block';

    splitRef.current = new GSAPSplitText(el, {
      type: 'chars',
      charsClass: 'split-char',
    });

    const tl = gsap.timeline({
      paused: true,
      onComplete: () => {
        // Entry finished — transition based on hover state
        if (isHoveredRef.current) {
          setAnimState('active');
        } else {
          // User already left while entering — immediately reverse out
          tl.reverse();
          setAnimState('exiting');
        }
      },
      onReverseComplete: () => {
        // Fully reversed back to start — tear down and show arrow
        try { splitRef.current?.revert(); } catch (_) {}
        splitRef.current = null;
        timelineRef.current = null;
        el.style.display = 'none';
        setAnimState('idle');
      },
    });

    tl.fromTo(
      splitRef.current.chars,
      { opacity: 0, y: 20 },
      {
        opacity: 1,
        y: 0,
        duration: 0.4,
        ease: 'power3.out',
        stagger: 0.03,
        force3D: true,
      }
    );

    timelineRef.current = tl;
    return tl;
  }, [cleanup, setAnimState]);

  // ── Hover handlers ────────────────────────────────────────────────────────

  const handleMouseEnter = useCallback(() => {
    isHoveredRef.current = true;
    const s = stateRef.current;

    if (s === 'idle') {
      const tl = buildTimeline();
      if (tl) {
        setAnimState('entering');
        tl.play();
      }
    } else if (s === 'exiting' && timelineRef.current) {
      // Interrupt exit — resume forward from current position
      setAnimState('entering');
      timelineRef.current.play();
    }
    // 'entering' — already heading towards active, onComplete checks isHoveredRef
    // 'active'   — nothing to do
    // 'loading'  — ignore, auth in progress
  }, [buildTimeline, setAnimState]);

  const handleMouseLeave = useCallback(() => {
    isHoveredRef.current = false;
    const s = stateRef.current;

    if (s === 'active' && timelineRef.current) {
      // Reverse the same timeline — chars animate out
      setAnimState('exiting');
      timelineRef.current.reverse();
    } else if (s === 'entering' && timelineRef.current) {
      // Already entering — onComplete will see isHoveredRef=false and auto-reverse
    }
    // 'exiting'  — already heading towards idle
    // 'idle'     — nothing to do
    // 'loading'  — ignore, auth in progress
  }, [setAnimState]);

  // ── Click handler ─────────────────────────────────────────────────────────

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (stateRef.current !== 'active') {
      e.preventDefault();
      return;
    }

    // Tear down the split timeline (chars are at final position so revert is seamless)
    timelineRef.current?.kill();
    timelineRef.current = null;
    try { splitRef.current?.revert(); } catch (_) {}
    splitRef.current = null;

    // Start shiny shimmer as a loading indicator
    applyShiny();
    setAnimState('loading');

    // Let the <Link> navigate normally — don't call e.preventDefault()
  }, [applyShiny, setAnimState]);

  // ── Reset on mount + bfcache restore ─────────────────────────────────────

  useEffect(() => {
    resetToIdle();

    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) resetToIdle();
    };
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      window.removeEventListener('pageshow', handlePageShow);
      cleanup();
    };
  }, [resetToIdle, cleanup]);

  // ── Render ────────────────────────────────────────────────────────────────

  const state = stateRef.current;

  return (
    <div
      className={`inline-flex items-center justify-center ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Link
        href={href}
        onClick={handleClick}
        className="inline-flex items-center justify-center"
        style={{ cursor: state === 'active' ? 'pointer' : 'default' }}
      >
        {state === 'idle' && <EnterIcon />}
        <span
          ref={textRef}
          className="text-white text-lg font-bold whitespace-nowrap"
          style={{ display: state === 'idle' ? 'none' : 'inline-block' }}
        >
          Continue with GitHub
        </span>
      </Link>
    </div>
  );
};

export default LandingTextAnimation;
