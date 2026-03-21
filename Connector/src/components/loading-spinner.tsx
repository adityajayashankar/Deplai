'use client';

import Lottie from 'lottie-react';
import loadingAnimation from '@/components/animation/loading.json';

type SpinnerSize = 'sm' | 'md' | 'lg';

const sizeClasses: Record<SpinnerSize, string> = {
  sm: 'w-12 h-12',
  md: 'w-20 h-20',
  lg: 'w-24 h-24',
};

interface LoadingSpinnerProps {
  size?: SpinnerSize;
  text?: string;
  className?: string;
  invert?: boolean;
}

export default function LoadingSpinner({ size = 'lg', text, className = '', invert = false }: LoadingSpinnerProps) {
  return (
    <div className={`text-center ${className}`}>
      <Lottie
        animationData={loadingAnimation}
        loop
        className={`${sizeClasses[size]} mx-auto ${invert ? 'invert' : 'dark:invert'} ${text ? 'mb-4' : ''}`}
      />
      {text && <p className="text-muted mt-4">{text}</p>}
    </div>
  );
}

export function LoadingScreen({ text, invert = false }: { text?: string; invert?: boolean }) {
  return (
    <div className="min-h-screen bg-header flex items-center justify-center">
      <LoadingSpinner size="lg" text={text} invert={invert} />
    </div>
  );
}
