import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const combat = read("src/routes/_authenticated/combate.tsx");
const viewer = read("src/components/combat/CombatPortraitViewer.tsx");

describe("Ampliação da foto do personagem no combate", () => {
  it("torna a foto de cada combatente um botão acessível, sem afetar os outros controles", () => {
    expect(combat).toContain('aria-label={`Ampliar imagem de ${f.name}`}');
    expect(combat).toContain('aria-haspopup="dialog"');
    expect(combat).toContain("onClick={() => setPreviewPortrait({ name: f.name, path: transformationImage })}");
    expect(combat).toContain('<Portrait path={transformationImage} name={f.name}');
    expect(combat).toContain("focus-visible:ring-2");
  });

  it("usa a imagem da transformação ativa, quando houver", () => {
    expect(combat).toContain("const transformationImage = activeTransformationState?.image_path || f.photo_path");
    expect(combat).toContain("path: transformationImage");
    expect(combat).toContain("portrait={previewPortrait}");
  });

  it("abre visualização ampliada sem cortar a foto, inclusive no celular", () => {
    expect(viewer).toContain("usePhotoUrl(portrait.path)");
    expect(viewer).toContain("max-h-[min(72dvh,750px)]");
    expect(viewer).toContain("max-w-full object-contain");
    expect(viewer).toContain("max-h-[95dvh]");
    expect(viewer).toContain('w-[calc(100vw-1rem)]');
    expect(viewer).toContain("alt={`Imagem ampliada de ${portrait.name}`}");
  });

  it("pode fechar pelo botão, pelo X padrão, pelo Escape ou clicando fora", () => {
    expect(viewer).toContain("<Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>");
    expect(viewer).toContain("<DialogContent");
    expect(viewer).toContain("onClick={onClose}");
    expect(viewer).toContain("Fechar");
    expect(combat).toContain("onClose={() => setPreviewPortrait(null)}");
  });

  it("não exibe imagem falsa quando não há foto cadastrada", () => {
    expect(viewer).toContain("portrait.path ? \"Carregando imagem...\" : \"Personagem sem imagem cadastrada\"");
    expect(viewer).toContain("<ImageOff");
  });
});
