/**
 * Provider-tiered model picker. Supported cloud providers are sorted by live
 * availability. Experimental providers are separated before sorting so a warm
 * local process never becomes the apparent happy path.
 */

import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Popover,
  Progress,
  ScrollArea,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  CheckIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  LightningBoltIcon,
  ImageIcon,
  HomeIcon,
} from "@radix-ui/react-icons";
import type { ModelCatalog, ModelCatalogEntry } from "@workspace/agentic-core";
import {
  isModelUsable,
  LOCAL_FALLBACK_MODEL_REF,
  LOCAL_PROVIDER_ID,
  type ModelAvailability,
} from "@workspace/model-catalog/catalog";

export interface ModelPickerProps {
  catalog: ModelCatalog | null;
  /** Currently selected "provider:modelId" ref. */
  value: string;
  onChange: (ref: string) => void;
  /** Deep-link into the Local Models panel's failing-server log (item 6).
   *  Wired only when the host can open panels; when set, a local model's red
   *  error dot becomes a one-click jump to that server's log. */
  onOpenServerLog?: (server: "utility" | "main") => void;
}

/** Which local server backs a model ref — the fallback rides the utility
 *  server (design §3), every other local model rides the main router. */
function serverForLocalRef(ref: string): "utility" | "main" {
  return ref === LOCAL_FALLBACK_MODEL_REF ? "utility" : "main";
}

const NEEDS_SETUP: ModelAvailability = { state: "needs-setup", detail: "no-credential" };

function availabilityOf(model: ModelCatalogEntry): ModelAvailability {
  return model.availability ?? NEEDS_SETUP;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function measuredTokensPerSec(model: ModelCatalogEntry): number | null {
  const tokensPerSec = model.tokensPerSec;
  return typeof tokensPerSec === "number" && Number.isFinite(tokensPerSec) ? tokensPerSec : null;
}

function sortReadyModels(models: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return models
    .map((model, index) => ({ model, index, tokensPerSec: measuredTokensPerSec(model) }))
    .sort((a, b) => {
      if (a.tokensPerSec !== null || b.tokensPerSec !== null) {
        if (a.tokensPerSec === null) return 1;
        if (b.tokensPerSec === null) return -1;
        if (a.tokensPerSec !== b.tokensPerSec) return b.tokensPerSec - a.tokensPerSec;
      }
      return a.index - b.index;
    })
    .map(({ model }) => model);
}

export interface ModelPickerPartition {
  standard: ModelCatalogEntry[];
  experimentalLocal: ModelCatalogEntry[];
}

/** Provider maturity outranks runtime availability in the picker hierarchy. */
export function partitionModelPickerModels(
  models: readonly ModelCatalogEntry[],
  query: string
): ModelPickerPartition {
  const normalizedQuery = query.trim().toLowerCase();
  const matching = normalizedQuery
    ? models.filter(
        (model) =>
          model.name.toLowerCase().includes(normalizedQuery) ||
          model.provider.toLowerCase().includes(normalizedQuery) ||
          model.ref.toLowerCase().includes(normalizedQuery)
      )
    : [...models];
  return {
    standard: matching.filter((model) => model.provider !== LOCAL_PROVIDER_ID),
    experimentalLocal: matching.filter((model) => model.provider === LOCAL_PROVIDER_ID),
  };
}

function dotColor(availability: ModelAvailability): string {
  switch (availability.state) {
    case "ready":
      return "var(--green-9)";
    case "startable":
    case "starting":
    case "downloading":
      return "var(--amber-9)";
    case "error":
      return "var(--red-9)";
    default:
      return "var(--gray-7)";
  }
}

function statusLabel(availability: ModelAvailability): string | null {
  switch (availability.state) {
    case "ready":
      return null;
    case "startable":
      return "loads on use";
    case "starting":
      return "starting…";
    case "downloading":
      return availability.phase === "paused"
        ? "download paused"
        : availability.phase === "queued"
          ? "download queued"
          : `downloading ${Math.round(availability.progress * 100)}%`;
    case "error":
      return availability.message;
    case "needs-setup":
      switch (availability.detail) {
        case "no-credential":
          return "not connected";
        case "credential-expired":
          return "connection expired";
        case "not-installed":
          return "not installed";
      }
  }
}

function StatusDot({
  availability,
  onOpenLog,
}: {
  availability: ModelAvailability;
  /** When set on an error dot, the dot becomes a button that opens the log. */
  onOpenLog?: () => void;
}) {
  const dot = (
    <Box
      as="span"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        minWidth: 8,
        borderRadius: 999,
        background: dotColor(availability),
      }}
    />
  );
  if (availability.state === "downloading" && availability.phase === "active") {
    return <Spinner size="1" />;
  }
  if (availability.state === "error") {
    if (onOpenLog) {
      return (
        <Tooltip content={`${availability.message} — click to open the server log`}>
          <button
            type="button"
            aria-label="Open the failing server's log"
            onClick={(e) => {
              e.stopPropagation();
              onOpenLog();
            }}
            style={{ all: "unset", cursor: "pointer", display: "inline-flex", lineHeight: 0 }}
          >
            {dot}
          </button>
        </Tooltip>
      );
    }
    return <Tooltip content={availability.message}>{dot}</Tooltip>;
  }
  return dot;
}

function ModelChips({ model }: { model: ModelCatalogEntry }) {
  const onDevice = model.provider === "local";
  const tokensPerSec = measuredTokensPerSec(model);
  const throughputBadge =
    tokensPerSec !== null ? (
      <Badge color={tokensPerSec < 10 ? "amber" : "gray"} variant="soft" size="1">
        {Math.round(tokensPerSec)} tok/s
      </Badge>
    ) : null;
  return (
    <Flex gap="2" align="center" wrap="wrap">
      {onDevice && (
        <Badge color="amber" variant="soft" size="1">
          <HomeIcon width="10" height="10" /> experimental
        </Badge>
      )}
      {model.reasoning && (
        <Badge color="purple" variant="soft" size="1">
          <LightningBoltIcon width="10" height="10" /> reasoning
        </Badge>
      )}
      {model.vision && (
        <Badge color="blue" variant="soft" size="1">
          <ImageIcon width="10" height="10" /> vision
        </Badge>
      )}
      <Badge color="gray" variant="soft" size="1">
        {formatContext(model.contextWindow)}
      </Badge>
      {tokensPerSec !== null && tokensPerSec < 10 ? (
        <Tooltip content="slow on this hardware">{throughputBadge}</Tooltip>
      ) : (
        throughputBadge
      )}
    </Flex>
  );
}

function ModelRow({
  model,
  providerLabel,
  selected,
  onSelect,
  onOpenServerLog,
}: {
  model: ModelCatalogEntry;
  providerLabel: string;
  selected: boolean;
  onSelect: () => void;
  onOpenServerLog?: (server: "utility" | "main") => void;
}) {
  const availability = availabilityOf(model);
  const label = statusLabel(availability);
  const openLog =
    onOpenServerLog && model.provider === "local" && availability.state === "error"
      ? () => onOpenServerLog(serverForLocalRef(model.ref))
      : undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "block",
        width: "100%",
        borderRadius: 6,
        padding: "6px 8px",
        background: selected ? "var(--accent-a3)" : undefined,
        opacity: isModelUsable(model) ? 1 : 0.75,
      }}
    >
      <Flex justify="between" align="center" gap="2">
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Flex align="center" gap="2">
            <StatusDot availability={availability} onOpenLog={openLog} />
            {selected && <CheckIcon />}
            <Text size="2" weight="medium" truncate>
              {model.name}
            </Text>
          </Flex>
          <Text size="1" color={availability.state === "error" ? "red" : "gray"}>
            {providerLabel}
            {label ? ` · ${label}` : ""}
          </Text>
          {availability.state === "downloading" ? (
            <Progress value={Math.round(availability.progress * 100)} size="1" mt="1" />
          ) : null}
        </Box>
        <ModelChips model={model} />
      </Flex>
    </button>
  );
}

/** One collapsed setup row for a provider with nothing usable. Selecting it
 * chooses the provider's best model; the surrounding agent setup surface then
 * owns connection or installation and blocks launch until availability flips. */
function ProviderSetupRow({
  providerLabel,
  models,
  onSelect,
}: {
  providerLabel: string;
  models: ModelCatalogEntry[];
  onSelect: (ref: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const best = models.find((m) => m.recommended) ?? models[0];
  if (!best) return null;
  return (
    <Box>
      <Flex align="center" justify="between" gap="2" style={{ padding: "4px 8px" }}>
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <StatusDot availability={NEEDS_SETUP} />
          <Text size="2" truncate>
            {providerLabel}
          </Text>
          <Text size="1" color="gray">
            {models.length} models
          </Text>
        </Flex>
        <Flex align="center" gap="2">
          <Button size="1" variant="soft" onClick={() => onSelect(best.ref)}>
            Choose
          </Button>
          <Button size="1" variant="ghost" color="gray" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide" : "Show"}
          </Button>
        </Flex>
      </Flex>
      {expanded && (
        <Flex direction="column" gap="1" ml="4">
          {models.map((m) => (
            <ModelRow
              key={m.ref}
              model={m}
              providerLabel={providerLabel}
              selected={false}
              onSelect={() => onSelect(m.ref)}
            />
          ))}
        </Flex>
      )}
    </Box>
  );
}

export function ModelPicker({ catalog, value, onChange, onOpenServerLog }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showExperimental, setShowExperimental] = useState(false);

  const models = useMemo(() => catalog?.models ?? [], [catalog]);
  const providerLabels = useMemo(
    () => new Map((catalog?.providers ?? []).map((provider) => [provider.id, provider.label])),
    [catalog]
  );
  const selected = models.find((m) => m.ref === value) ?? null;

  const partition = useMemo(() => partitionModelPickerModels(models, query), [models, query]);

  const groups = useMemo(() => {
    const ready: ModelCatalogEntry[] = [];
    const startable: ModelCatalogEntry[] = [];
    const busy: ModelCatalogEntry[] = []; // starting / downloading / error — visible, actionable
    const needsSetup = new Map<string, ModelCatalogEntry[]>();
    for (const model of partition.standard) {
      const availability = availabilityOf(model);
      switch (availability.state) {
        case "ready":
          ready.push(model);
          break;
        case "startable":
          startable.push(model);
          break;
        case "starting":
        case "downloading":
        case "error":
          busy.push(model);
          break;
        case "needs-setup": {
          const list = needsSetup.get(model.provider) ?? [];
          list.push(model);
          needsSetup.set(model.provider, list);
          break;
        }
      }
    }
    return { ready: sortReadyModels(ready), startable, busy, needsSetup };
  }, [partition.standard]);

  const select = (ref: string) => {
    onChange(ref);
    setOpen(false);
  };

  const renderGroup = (label: string, list: ModelCatalogEntry[]) =>
    list.length > 0 && (
      <Box mb="2">
        <Text size="1" color="gray" weight="bold" style={{ textTransform: "uppercase" }}>
          {label}
        </Text>
        <Flex direction="column" gap="1" mt="1">
          {list.map((m) => (
            <ModelRow
              key={m.ref}
              model={m}
              providerLabel={providerLabels.get(m.provider) ?? m.provider}
              selected={m.ref === value}
              onSelect={() => select(m.ref)}
              onOpenServerLog={onOpenServerLog}
            />
          ))}
        </Flex>
      </Box>
    );

  const selectedAvailability = selected ? availabilityOf(selected) : null;
  const selectedLabel = selectedAvailability ? statusLabel(selectedAvailability) : null;
  const selectedOpenLog =
    onOpenServerLog && selected?.provider === "local" && selectedAvailability?.state === "error"
      ? () => onOpenServerLog(serverForLocalRef(selected.ref))
      : undefined;
  const experimentalForcedOpen =
    selected?.provider === LOCAL_PROVIDER_ID || query.trim().length > 0;
  const experimentalExpanded = experimentalForcedOpen || showExperimental;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button
          variant="surface"
          color="gray"
          style={{ justifyContent: "space-between", width: "100%" }}
        >
          <Flex align="center" gap="2" style={{ minWidth: 0 }}>
            {selectedAvailability && (
              <StatusDot availability={selectedAvailability} onOpenLog={selectedOpenLog} />
            )}
            <Text truncate>{selected ? selected.name : value || "Choose a model"}</Text>
            {selectedLabel && (
              <Badge
                color={selectedAvailability?.state === "error" ? "red" : "amber"}
                variant="soft"
                size="1"
              >
                {selectedLabel}
              </Badge>
            )}
          </Flex>
          <ChevronDownIcon />
        </Button>
      </Popover.Trigger>
      <Popover.Content style={{ width: "min(440px, calc(100vw - 32px))" }}>
        <TextField.Root
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          mb="2"
          autoFocus
        >
          <TextField.Slot>
            <MagnifyingGlassIcon />
          </TextField.Slot>
        </TextField.Root>
        <ScrollArea type="auto" scrollbars="vertical" style={{ maxHeight: 360 }}>
          <Box pr="2">
            {renderGroup("Ready", groups.ready)}
            {renderGroup("Available to start", groups.startable)}
            {renderGroup("Setup in progress or needs attention", groups.busy)}
            {groups.needsSetup.size > 0 && (
              <Box mb="2">
                <Text size="1" color="gray" weight="bold" style={{ textTransform: "uppercase" }}>
                  Needs setup
                </Text>
                <Flex direction="column" gap="1" mt="1">
                  {[...groups.needsSetup.entries()].map(([providerId, list]) => (
                    <ProviderSetupRow
                      key={providerId}
                      providerLabel={providerLabels.get(providerId) ?? providerId}
                      models={list}
                      onSelect={select}
                    />
                  ))}
                </Flex>
              </Box>
            )}
            {partition.experimentalLocal.length > 0 && (
              <Box mt="3" mb="2" pt="2" style={{ borderTop: "1px solid var(--gray-a5)" }}>
                <Button
                  type="button"
                  size="1"
                  variant="ghost"
                  color="gray"
                  aria-expanded={experimentalExpanded}
                  onClick={() => setShowExperimental((visible) => !visible)}
                  style={{ width: "100%", justifyContent: "space-between" }}
                >
                  <Flex align="center" gap="2">
                    <Badge size="1" color="amber" variant="soft">
                      Experimental
                    </Badge>
                    <Text size="2">Local inference</Text>
                  </Flex>
                  <ChevronDownIcon
                    style={{
                      transform: experimentalExpanded ? "rotate(180deg)" : undefined,
                      transition: "transform 120ms ease",
                    }}
                  />
                </Button>
                {experimentalExpanded ? (
                  <Box mt="1">
                    <Text
                      size="1"
                      color="gray"
                      as="p"
                      mb="2"
                      style={{ paddingInline: "var(--space-2)" }}
                    >
                      Early preview. Agent tool use and response times may be unreliable.
                    </Text>
                    <Flex direction="column" gap="1">
                      {partition.experimentalLocal.map((model) => (
                        <ModelRow
                          key={model.ref}
                          model={model}
                          providerLabel={
                            providerLabels.get(model.provider) ?? "Local inference (experimental)"
                          }
                          selected={model.ref === value}
                          onSelect={() => select(model.ref)}
                          onOpenServerLog={onOpenServerLog}
                        />
                      ))}
                    </Flex>
                  </Box>
                ) : null}
              </Box>
            )}
            {partition.standard.length === 0 && partition.experimentalLocal.length === 0 && (
              <Text size="2" color="gray">
                No models match “{query}”.
              </Text>
            )}
          </Box>
        </ScrollArea>
      </Popover.Content>
    </Popover.Root>
  );
}
