import { useEffect, useRef } from "react";
import { useReducedMotion } from "./ui";

/* A small octopus drifting across the page. Darts away from the cursor,
   puffs ink when properly startled, and peeks over the footer edge. */
export default function Octopus() {
    const ref = useRef(null);
    const reduced = useReducedMotion();

    useEffect(() => {
        if (reduced) return undefined;
        const el = ref.current;
        if (!el) return undefined;
        let x = window.innerWidth * 0.72;
        let y = window.innerHeight * 0.7;
        let tx = x;
        let ty = y;
        let vx = 0;
        let vy = 0;
        let lastPick = 0;
        let lastInk = 0;
        let peekTarget = false;
        let raf;

        const footer = document.querySelector(".dl-footer");

        const spawnInk = () => {
            const ink = document.createElement("div");
            ink.className = "dl-ink";
            ink.style.left = `${x - 26}px`;
            ink.style.top = `${y - 26}px`;
            document.body.appendChild(ink);
            ink.addEventListener("animationend", () => ink.remove());
        };

        const pick = (now) => {
            lastPick = now;
            const vh = window.innerHeight;
            const footerTop = footer ? footer.getBoundingClientRect().top : Infinity;
            if (footerTop < vh * 0.96) {
                peekTarget = true;
                tx = 70 + Math.random() * (window.innerWidth - 180);
                ty = Math.min(vh - 14, footerTop - 16);
            } else {
                peekTarget = false;
                tx = 50 + Math.random() * (window.innerWidth - 130);
                ty = vh * 0.4 + Math.random() * vh * 0.55;
            }
        };

        const onMove = (e) => {
            const dx = x - e.clientX;
            const dy = y - e.clientY;
            const d = Math.hypot(dx, dy);
            if (d < 150) {
                const f = ((150 - d) / 150) * 9;
                vx += (dx / (d || 1)) * f;
                vy += (dy / (d || 1)) * f;
            }
        };

        const step = (now) => {
            if (now - lastPick > 5200) pick(now);
            vx += (tx - x) * 0.0011;
            vy += (ty - y) * 0.0011;
            vx *= 0.94;
            vy *= 0.94;
            x += vx;
            y += vy;
            const speed = Math.hypot(vx, vy);
            if (speed > 8.5 && now - lastInk > 2600) {
                lastInk = now;
                spawnInk();
            }
            el.style.transform = `translate(${x}px, ${y}px) scaleX(${vx < -0.4 ? -1 : 1})`;
            el.classList.toggle("darting", speed > 3.4);
            el.classList.toggle("peeking", peekTarget && Math.hypot(tx - x, ty - y) < 40);
            raf = requestAnimationFrame(step);
        };

        pick(0);
        window.addEventListener("pointermove", onMove, { passive: true });
        raf = requestAnimationFrame(step);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("pointermove", onMove);
        };
    }, [reduced]);

    if (reduced) return null;

    return (
        <div className="dl-octo" ref={ref} data-testid="octopus" aria-hidden="true">
            <svg viewBox="0 0 72 66" width="100%" fill="none">
                <g className="tents" stroke="#7b61ff" strokeWidth="5" strokeLinecap="round">
                    <path d="M18,38 q-7,10 -1,17 q5,6 11,2" />
                    <path d="M28,42 q-3,12 2,19" />
                    <path d="M40,43 q1,12 7,17" />
                    <path d="M52,38 q8,9 3,17 q-4,6 -10,3" />
                </g>
                <ellipse cx="36" cy="27" rx="21" ry="21" fill="#7b61ff" />
                <ellipse cx="36" cy="21" rx="15" ry="12" fill="#8f76ff" opacity="0.7" />
                <circle cx="28" cy="26" r="5.5" fill="#f4f0ea" />
                <circle cx="29" cy="27" r="2.6" fill="#0b101d" />
                <circle cx="46" cy="26" r="5.5" fill="#f4f0ea" />
                <circle cx="47" cy="27" r="2.6" fill="#0b101d" />
                <rect x="30" y="38" width="12" height="3" rx="1.5" fill="#5a44c8" />
            </svg>
        </div>
    );
}
