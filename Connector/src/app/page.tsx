'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { LoadingScreen } from '@/components/loading-spinner';

import Threads from '@/components/background-animation';
import LogoLoop from '@/components/logo-loop';
import LandingTextAnimation from '@/components/landing-text-animation';
import { SiGithub, SiNextdotjs, SiDocker, SiLangchain, SiPrisma, SiTailwindcss, SiPython } from 'react-icons/si';

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authKey, setAuthKey] = useState(0);

  const checkAuth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/session');
      const session = await res.json();

      if (session.isLoggedIn) {
        router.push('/dashboard');
        return;
      }

      setAuthKey(k => k + 1);
      setLoading(false);
    } catch (error) {
      console.error('Auth check failed:', error);
      setAuthKey(k => k + 1);
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    checkAuth();

    // Re-check auth when page becomes visible again (SPA back-navigation, tab switch)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') checkAuth();
    };
    // Re-check on bfcache restore (browser back/forward)
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) checkAuth();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [checkAuth]);

  if (loading) {
    return <LoadingScreen invert />;
  }

  return (
    <div className="min-h-screen bg-black relative">
      {/* Threads Background */}
      <div className="absolute inset-0 z-0">
        <Threads
          color={[1, 1, 1]}
          amplitude={1}
          distance={0}
          enableMouseInteraction
        />
      </div>

      {/* Navigation */}
      <motion.nav
        className="container mx-auto px-6 py-6 relative z-10"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-white text-2xl font-bold">DEPLAI</span>
          </div>
          <LandingTextAnimation key={authKey} href="/api/auth/login" />
        </div>
      </motion.nav>

      {/* Hero Section */}
      <div className="container mx-auto px-6 py-20 relative z-10">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <motion.div
            className="inline-flex items-center space-x-2 bg-blue-500/10 border border-blue-500/20 rounded-full px-4 py-2 mb-8"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
            <span className="text-white text-sm">AI-Powered Platform</span>
          </motion.div>

          {/* Headline with staggered animation */}
          <h1 className="text-6xl md:text-7xl font-bold text-white mb-6 leading-tight">
            <motion.div
              initial={{ opacity: 0, x: -50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
            >
              Deploy Anywhere
            </motion.div>
            <motion.span
              className="text-white inline-block"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.5 }}
            >
              Test Everything
            </motion.span>
          </h1>

        </div>
      </div>

      {/* Logo Loop */}
      <div className="absolute bottom-32 left-0 right-0 z-10 flex justify-center">
        <div className="max-w-212.5 w-full h-30 overflow-hidden text-white">
          <LogoLoop
            logos={[
              { node: <SiGithub />, title: "GitHub", href: "https://github.com" },
              { node: <SiLangchain />, title: "LangGraph", href: "https://www.langchain.com/langgraph" },
              { node: <SiNextdotjs />, title: "Next.js", href: "https://nextjs.org" },
              { node: <SiDocker />, title: "Docker", href: "https://www.docker.com" },
              { node: <SiPrisma />, title: "Prisma", href: "https://www.prisma.io" },
              { node: <SiTailwindcss />, title: "Tailwind CSS", href: "https://tailwindcss.com" },
              { node: <SiPython />, title: "Python", href: "https://www.python.org" },
            ]}
            speed={60}
            direction="left"
            logoHeight={55}
            gap={60}
            hoverSpeed={0}
            fadeOut
            fadeOutColor="#000000"
            ariaLabel="Technology partners"
          />
        </div>
      </div>

      {/* Footer */}
      <motion.footer
        className="container mx-auto px-6 py-8 border-t border-white/10 absolute bottom-0 left-0 right-0 z-10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 1 }}
      >
        <div className="text-center">
          <div className="text-gray-400 text-sm">
             Built for developers, by developers.
          </div>
        </div>
      </motion.footer>
    </div>
  );
}
