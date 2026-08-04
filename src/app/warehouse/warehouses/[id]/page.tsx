import { Printer } from "lucide-react";
import { requireAdminPage } from "@/lib/auth";
import { scoped } from "@/lib/tenant";
import { getAllowedWarehouse } from "@/lib/warehouse-access";
import { warehouseZonesEnabled, coolingWorkflowEnabled } from "@/lib/roles";
import {
  updateWarehouseAction,
  createCellsAction,
  renameZoneAction,
  addZoneAction,
} from "@/app/actions/warehouses";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Field, Badge, EmptyState, DownloadButton, SelectField } from "@/components/ui";
import { PageShell } from "@/components/page-shell";
import { CellTile } from "../cell-tile";
import { ZoneCellTile } from "../zone-cell-tile";
import { CreateCellsForm } from "../create-cells-form";
import {
  ZONE_KIND_LABEL,
  ZONE_KIND_TONE,
  PHYSICAL_ZONE_KINDS,
  isPhysicalZoneKind,
  isVirtualZoneKind,
} from "@/lib/zones";

export default async function WarehousePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const s = scoped(session);
  const { id } = await params;
  const warehouse = await getAllowedWarehouse(session, s.companyId, id);
  const cells = await s.cells(id);

  const title = (
    <span className="flex items-center gap-2.5">
      {warehouse.name}
      {!warehouse.isActive && <Badge tone="red">неактивен</Badge>}
    </span>
  );
  const qrAction =
    cells.length > 0 ? (
      <DownloadButton href={`/warehouse/print/labels/pdf?cells=${warehouse.id}`}>
        <Printer size={18} /> QR ячеек
      </DownloadButton>
    ) : undefined;

  // ── Режим зон (Пакет 3) ──
  if (warehouseZonesEnabled()) {
    const zones = await s.zones(id);
    const physical = zones.filter((z) => isPhysicalZoneKind(z.kind));
    const virtual = zones.filter((z) => isVirtualZoneKind(z.kind));
    const physOpts = physical.map((z) => ({ id: z.id, name: z.name, kind: z.kind }));
    const zoneById = new Map(zones.map((z) => [z.id, z]));

    const byZone = new Map<string, typeof cells>();
    for (const c of cells) {
      const k = c.zoneId && zoneById.has(c.zoneId) ? c.zoneId : "__none__";
      const arr = byZone.get(k);
      if (arr) arr.push(c);
      else byZone.set(k, [c]);
    }
    const orphan = byZone.get("__none__") ?? [];

    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageShell title={title} action={qrAction}>
          {/* Физические зоны — секциями */}
          {physical.map((z) => {
            const zc = byZone.get(z.id) ?? [];
            return (
              <Card key={z.id}>
                <CardTitle>
                  <span className="flex flex-wrap items-center gap-2">
                    {z.name}
                    <Badge tone={ZONE_KIND_TONE[z.kind]}>{ZONE_KIND_LABEL[z.kind]}</Badge>
                    <span className="text-sm font-normal text-neutral-400">({zc.length})</span>
                  </span>
                </CardTitle>
                {zc.length === 0 ? (
                  <EmptyState>В этой зоне пока нет ячеек.</EmptyState>
                ) : (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {zc.map((c) => (
                      <ZoneCellTile
                        key={c.id}
                        cell={{
                          id: c.id,
                          code: c.code,
                          level: c.level,
                          isActive: c.isActive,
                          zoneId: c.zoneId,
                          zoneName: z.name,
                          zoneKind: z.kind,
                        }}
                        zones={physOpts}
                      />
                    ))}
                  </div>
                )}
              </Card>
            );
          })}

          {/* Ячейки без зоны (наследие) */}
          {orphan.length > 0 && (
            <Card>
              <CardTitle>
                <span className="flex items-center gap-2">
                  Без зоны <Badge tone="orange">требует настройки</Badge>
                  <span className="text-sm font-normal text-neutral-400">({orphan.length})</span>
                </span>
              </CardTitle>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {orphan.map((c) => (
                  <ZoneCellTile
                    key={c.id}
                    cell={{ id: c.id, code: c.code, level: c.level, isActive: c.isActive, zoneId: c.zoneId, zoneName: null, zoneKind: null }}
                    zones={physOpts}
                  />
                ))}
              </div>
            </Card>
          )}

          {/* Виртуальные (системные) зоны — без плиток ячеек */}
          {virtual.length > 0 && (
            <Card>
              <CardTitle>Системные зоны</CardTitle>
              <div className="flex flex-col gap-2">
                {virtual.map((z) => (
                  <div
                    key={z.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[#eee] bg-neutral-50/60 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{z.name}</div>
                      <div className="text-xs text-neutral-500">Работает как одна большая ячейка — без отдельных ячеек.</div>
                    </div>
                    <Badge tone={ZONE_KIND_TONE[z.kind]}>{ZONE_KIND_LABEL[z.kind]}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Создание ячеек в зоне */}
          <Card className="lg:max-w-2xl">
            <CardTitle>Добавить ячейки</CardTitle>
            <CreateCellsForm warehouseId={warehouse.id} zones={physOpts} />
          </Card>

          {/* Управление зонами: переименование + добавление физической зоны */}
          <Card className="lg:max-w-2xl">
            <CardTitle>Зоны склада</CardTitle>
            <div className="flex flex-col gap-2">
              {zones.map((z) => (
                <form key={z.id} action={renameZoneAction} className="flex items-center gap-2">
                  <input type="hidden" name="zoneId" value={z.id} />
                  <Badge tone={ZONE_KIND_TONE[z.kind]}>{ZONE_KIND_LABEL[z.kind]}</Badge>
                  <input
                    name="name"
                    defaultValue={z.name}
                    className="min-w-0 flex-1 rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm"
                  />
                  <button type="submit" className="shrink-0 rounded-lg border border-[#e4e4f0] px-3 py-1.5 text-sm active:bg-neutral-50">
                    Сохранить
                  </button>
                </form>
              ))}
            </div>
            <div className="mt-4 border-t border-[#eee] pt-3">
              <ActionForm action={addZoneAction} submitLabel="Добавить зону" variant="ghost">
                <input type="hidden" name="warehouseId" value={warehouse.id} />
                <div className="grid grid-cols-2 gap-3">
                  <SelectField name="kind" defaultValue="STORAGE" className="text-sm">
                    {PHYSICAL_ZONE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {ZONE_KIND_LABEL[k]}
                      </option>
                    ))}
                  </SelectField>
                  <Field label="" name="name" required placeholder="Название зоны" />
                </div>
              </ActionForm>
            </div>
          </Card>

          {/* Настройки склада */}
          <Card className="lg:max-w-2xl">
            <CardTitle>Настройки склада</CardTitle>
            <ActionForm action={updateWarehouseAction} submitLabel="Сохранить" variant="ghost">
              <input type="hidden" name="id" value={warehouse.id} />
              <Field label="Название" name="name" required defaultValue={warehouse.name} />
              <Field label="Адрес" name="address" defaultValue={warehouse.address ?? ""} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isActive" defaultChecked={warehouse.isActive} className="h-5 w-5" />
                Склад активен
              </label>
              {coolingWorkflowEnabled() && (
                <Field
                  label="Скорость охлаждения R, °C/час"
                  name="coolingRate"
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  defaultValue={warehouse.coolingRate === null ? "" : String(warehouse.coolingRate)}
                />
              )}
            </ActionForm>
          </Card>
        </PageShell>
      </div>
    );
  }

  // ── Прежний режим (флаг выключен) ──
  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageShell title={title} action={qrAction}>
        <Card>
          <CardTitle>Ячейки ({cells.length})</CardTitle>
          {cells.length === 0 ? (
            <EmptyState>Ячеек нет — создайте диапазон ниже.</EmptyState>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {cells.map((c) => (
                <CellTile key={c.id} cell={{ id: c.id, code: c.code, isStaging: c.isStaging, isActive: c.isActive }} />
              ))}
            </div>
          )}
        </Card>

        <Card className="lg:max-w-2xl">
          <CardTitle>Добавить ячейки (диапазон)</CardTitle>
          <ActionForm action={createCellsAction} submitLabel="Создать ячейки">
            <input type="hidden" name="warehouseId" value={warehouse.id} />
            <Field label="Префикс" name="prefix" required placeholder="А-" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="С номера" name="from" type="number" required inputMode="numeric" placeholder="1" />
              <Field label="По номер" name="to" type="number" required inputMode="numeric" placeholder="20" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isStaging" className="h-5 w-5" />
              Ячейки зоны выдачи (для собранных заявок)
            </label>
            <p className="text-xs text-neutral-400">
              Одна ячейка — это диапазон из одного номера, например «Б-» с 1 по 1.
            </p>
          </ActionForm>
        </Card>

        <Card className="lg:max-w-2xl">
          <CardTitle>Настройки склада</CardTitle>
          <ActionForm action={updateWarehouseAction} submitLabel="Сохранить" variant="ghost">
            <input type="hidden" name="id" value={warehouse.id} />
            <Field label="Название" name="name" required defaultValue={warehouse.name} />
            <Field label="Адрес" name="address" defaultValue={warehouse.address ?? ""} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked={warehouse.isActive} className="h-5 w-5" />
              Склад активен
            </label>
            {coolingWorkflowEnabled() && (
              <Field
                label="Скорость охлаждения R, °C/час"
                name="coolingRate"
                type="number"
                inputMode="decimal"
                step="0.1"
                defaultValue={warehouse.coolingRate === null ? "" : String(warehouse.coolingRate)}
              />
            )}
          </ActionForm>
        </Card>
      </PageShell>
    </div>
  );
}
