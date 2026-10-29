import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const details = read("src/components/summons/SummonDetailsDialog.tsx");
const transformations = read("src/components/transformations/CharacterTransformationImages.tsx");
const playerSheet = read("src/routes/_authenticated/ficha.$id.tsx");
const playerPanel = read("src/routes/_authenticated/painel.tsx");
const migration = read("drizzle/migrations/201_summon_portrait_player_access.sql");

describe("Imagens de invocações na visão do jogador", () => {
  it("o detalhe da invocação exibe a foto da criatura com fallback visual", () => {
    expect(details).toContain("photo_path: string | null");
    expect(details).toContain("usePhotoUrl(c.photo_path)");
    expect(details).toContain('alt={`Imagem da invocação ${details.name}`}');
    expect(details).toContain('className="h-full w-full object-cover"');
    expect(details).toContain("Invocação sem imagem cadastrada");
    expect(details).toContain("Somente leitura:");
    expect(playerSheet).toContain("<SummonGrantsEditor characterId={data.character.id} master={false} />");
  });

  it("a foto vem da ficha original inclusive enquanto há cópia ativa no combate", () => {
    expect(migration).toContain("public.get_summon_details(uuid)");
    expect(migration).toContain("template.photo_path");
    expect(migration).toContain("_grant.template_character_id");
    expect(migration).toContain("'photo_path'");
  });

  it("as fotos de outras pessoas continuam protegidas por vínculo ou combate autorizado", () => {
    expect(migration).toContain("public.can_read_character_photo(_photo_character_id text)");
    expect(migration).toContain("summoner.owner_id=auth.uid()");
    expect(migration).toContain("g.template_character_id::text=_photo_character_id");
    expect(migration).toContain("public.battle_participants photo_participant");
    expect(migration).not.toContain("USING (true)");
  });
});

describe("Visão do jogador na ficha do mestre", () => {
  it("inclui Transformações, Invocações e Inventário em abas próprias", () => {
    expect(playerSheet).toContain('const [previewTab, setPreviewTab] = useState<SheetTabKey>("overview")');
    expect(playerSheet).toContain("<SheetSectionTabs active={previewTab} onChange={setPreviewTab}");
    expect(playerSheet).toContain('<SheetTabPanel tab="transformations" active={previewTab}>');
    expect(playerSheet).toContain('<CharacterTransformationImages character={character} />');
    expect(playerSheet).toContain('<SheetTabPanel tab="abilities" active={previewTab}>');
    expect(playerSheet).toContain('<SummonGrantsEditor characterId={character.id} master={false} />');
    expect(playerSheet).toContain('<SheetTabPanel tab="inventory" active={previewTab}>');
    expect(playerSheet).toContain('<InventoryPanel characterId={character.id} />');
  });

  it("mantém a edição de imagens exclusiva do mestre e a visualização para jogadores", () => {
    expect(transformations).toContain("const imageUrl = usePhotoUrl(state?.image_path)");
    expect(transformations).toContain('<img src={imageUrl} alt={transformation.name}');
    expect(transformations).toContain("{isMaster && (");
    expect(playerPanel).toContain("<CharacterTransformationImages character={data.character} />");
    expect(playerSheet).toContain("<CharacterTransformationImages character={data.character} />");
    expect(playerSheet).toContain("<CharacterTransformationImages character={character} isMaster />");
  });
});
