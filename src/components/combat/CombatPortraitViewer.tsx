import { ImageOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePhotoUrl } from "@/lib/sheets";

export type CombatPortrait = {
  name: string;
  path: string | null;
};

/**
 * Full-size photo of the combatant, including an active transformation image.
 * Uses the same authorized, signed portrait URL as the small card.
 */
export function CombatPortraitViewer({
  portrait,
  onClose,
}: {
  portrait: CombatPortrait;
  onClose: () => void;
}) {
  const url = usePhotoUrl(portrait.path);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[95dvh] w-[calc(100vw-1rem)] max-w-2xl flex-col gap-3 overflow-hidden rounded-2xl border border-gold/45 bg-[#140e0b] p-3 text-foreground shadow-[0_24px_90px_rgba(0,0,0,.9)] sm:w-[calc(100vw-2rem)] sm:gap-4 sm:p-5">
        <DialogHeader className="min-w-0 pr-8 text-left">
          <DialogTitle className="break-words font-display text-xl text-gold sm:text-2xl">
            {portrait.name}
          </DialogTitle>
          <DialogDescription>
            Retrato do personagem no combate
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-gold/25 bg-black/50 p-2">
          {url ? (
            <img
              src={url}
              alt={`Imagem ampliada de ${portrait.name}`}
              className="max-h-[min(72dvh,750px)] max-w-full object-contain"
            />
          ) : (
            <div className="flex min-h-44 w-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <ImageOff aria-hidden="true" className="h-10 w-10 text-gold/50" />
              <p className="text-sm">{portrait.path ? "Carregando imagem..." : "Personagem sem imagem cadastrada"}</p>
            </div>
          )}
        </div>
        <Button type="button" variant="outline" className="min-h-11 w-full border-gold/30 sm:ml-auto sm:w-auto" onClick={onClose}>
          <X aria-hidden="true" className="mr-2 h-4 w-4" /> Fechar
        </Button>
      </DialogContent>
    </Dialog>
  );
}
