import { useEffect, useState } from "react";
import "@/styles/base.css";
import "@/styles/scenes-a.css";
import "@/styles/scenes-b.css";
import "@/styles/scenes-c.css";
import { ScrollTrigger, useReducedMotion, scrollToScene } from "@/components/deplai/ui";
import Octopus from "@/components/deplai/Octopus";
import Nav from "@/components/deplai/Nav";
import ScenePort from "@/components/deplai/ScenePort";
import SceneLoad from "@/components/deplai/SceneLoad";
import SceneCourse from "@/components/deplai/SceneCourse";
import SceneCrew from "@/components/deplai/SceneCrew";
import SceneSecurity from "@/components/deplai/SceneSecurity";
import SceneStorm from "@/components/deplai/SceneStorm";
import SceneDestination from "@/components/deplai/SceneDestination";
import SceneWatch from "@/components/deplai/SceneWatch";
import SceneFleet from "@/components/deplai/SceneFleet";
import Footer from "@/components/deplai/Footer";

const SCENE_IDS = ["port", "load", "course", "crew", "security", "storm", "destination", "watch", "fleet"];

function App() {
    const [active, setActive] = useState("port");
    const reduced = useReducedMotion();

    useEffect(() => {
        if (reduced) return undefined;
        const onScroll = () => {
            const y = window.scrollY + window.innerHeight * 0.5;
            for (const id of SCENE_IDS) {
                const el = document.getElementById(id);
                if (!el) continue;
                const sp = el.closest(".pin-spacer") || el;
                const top = sp.getBoundingClientRect().top + window.scrollY;
                if (y >= top && y < top + sp.offsetHeight) {
                    setActive(id);
                    return;
                }
            }
        };
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
        const t = setTimeout(() => ScrollTrigger.refresh(), 2000);
        return () => {
            window.removeEventListener("scroll", onScroll);
            clearTimeout(t);
        };
    }, [reduced]);

    useEffect(() => {
        const onClick = (e) => {
            const a = e.target.closest('a[href^="#"]');
            if (!a) return;
            const id = a.getAttribute("href").slice(1);
            if (id && document.getElementById(id)) {
                e.preventDefault();
                scrollToScene(id);
            }
        };
        document.addEventListener("click", onClick);
        return () => document.removeEventListener("click", onClick);
    }, []);

    return (
        <div className={`dl-root ${reduced ? "dl-reduced" : ""}`}>
            <div className="dl-grain" aria-hidden="true" />
            <Nav active={active} />
            <Octopus />
            <main>
                <ScenePort />
                <SceneLoad />
                <SceneCourse />
                <SceneCrew />
                <SceneSecurity />
                <SceneStorm />
                <SceneDestination />
                <SceneWatch />
                <SceneFleet />
            </main>
            <Footer />
        </div>
    );
}

export default App;
