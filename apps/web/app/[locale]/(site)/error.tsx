'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center"
    >
      <h1 className="text-2xl font-bold">Something went wrong / Bir şeyler ters gitti</h1>
      <p className="text-muted-foreground">
        The radio keeps playing — try again. / Radyo çalmaya devam ediyor — tekrar dene.
      </p>
      <Button onClick={reset}>Try again / Tekrar dene</Button>
    </div>
  );
}
