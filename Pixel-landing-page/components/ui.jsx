import { useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";

gsap.registerPlugin(ScrollTrigger, MotionPathPlugin, ScrollToPlugin);

export { gsap, ScrollTrigger };

export function useReducedMotion() {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
        const fn = () => setReduced(mq.matches);
        fn();
        mq.addEventListener("change", fn);
        return () => mq.removeEventListener("change", fn);
    }, []);
    return reduced;
}

/* Fixed 1600x900 world space, scaled to cover the viewport.
   All scene art is authored in these coordinates so GSAP px
   animations line up on every screen size. */
export function World({ children, className = "" }) {
    const ref = useRef(null);
    useEffect(() => {
        const el = ref.current;
        const fit = () => {
            const s = Math.max(window.innerWidth / 1600, window.innerHeight / 900);
            el.style.transform = `translate(-50%,-50%) scale(${s})`;
        };
        fit();
        window.addEventListener("resize", fit);
        return () => window.removeEventListener("resize", fit);
    }, []);
    return (
        <div ref={ref} className={`dl-world ${className}`} aria-hidden="true">
            <div className="dl-pan">{children}</div>
        </div>
    );
}

/* Eased glide to a scene, accounting for pin spacers */
export function scrollToScene(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const sp = el.closest(".pin-spacer") || el;
    const y = sp.getBoundingClientRect().top + window.scrollY + window.innerHeight * 0.3;
    const dist = Math.abs(y - window.scrollY);
    gsap.to(window, {
        scrollTo: { y, autoKill: true },
        duration: Math.min(4.5, Math.max(0.9, dist / 3500)),
        ease: "power2.inOut",
    });
}
export function useScene(ref, reduced, end, build) {
    const buildRef = useRef(build);
    buildRef.current = build;
    useLayoutEffect(() => {
        if (reduced) return undefined;
        const ctx = gsap.context(() => {
            const tl = gsap.timeline({
                defaults: { ease: "none" },
                scrollTrigger: {
                    trigger: ref.current,
                    start: "top top",
                    end,
                    scrub: 1,
                    pin: true,
                    anticipatePin: 1,
                },
            });
            buildRef.current(tl, ref.current);
        }, ref);
        return () => ctx.revert();
    }, [reduced, ref, end]);
}
