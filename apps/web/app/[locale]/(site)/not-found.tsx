import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-bold">404</h1>
      <p className="text-muted-foreground">This page went off air. / Bu sayfa yayından kalktı.</p>
      <Button asChild>
        <Link href="/">RadioT</Link>
      </Button>
    </div>
  );
}
