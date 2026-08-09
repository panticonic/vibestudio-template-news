import { Badge, Box, Card, Flex, Progress, Text } from "@radix-ui/themes";
import { CheckIcon, CodeIcon } from "@radix-ui/react-icons";
import type { ModelCatalog, ModelCatalogEntry } from "@workspace/agentic-core";

const CODEX_PROVIDER_ID = "openai-codex";

export interface FirstAgentModelChoicesProps {
  catalog: ModelCatalog | null;
  value: string;
  onChange: (ref: string) => void;
}

function preferredModel(
  catalog: ModelCatalog | null,
  providerId: string
): ModelCatalogEntry | null {
  if (!catalog) return null;
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  const models = catalog.models.filter((model) => model.provider === providerId);
  return (
    catalog.models.find((model) => model.ref === provider?.recommendedModelRef) ??
    models.find((model) => model.recommended) ??
    models[0] ??
    null
  );
}

function availabilityLabel(model: ModelCatalogEntry): string {
  switch (model.availability.state) {
    case "ready":
      return "Ready";
    case "startable":
      return "Installed";
    case "needs-setup":
      return model.provider === CODEX_PROVIDER_ID
        ? "ChatGPT sign-in required"
        : model.availability.detail === "not-installed"
          ? "Download required"
          : "Setup needed";
    case "starting":
      return "Starting";
    case "downloading":
      return `Downloading ${Math.round(model.availability.progress * 100)}%`;
    case "error":
      return "Unavailable";
  }
}

function ModelChoice({
  model,
  selected,
  icon,
  title,
  badge,
  description,
  onSelect,
}: {
  model: ModelCatalogEntry;
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  badge: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <Card
      asChild
      size="2"
      variant={selected ? "surface" : "classic"}
      style={{
        flex: "1 1 210px",
        minWidth: 0,
        cursor: "pointer",
        outline: selected ? "2px solid var(--accent-8)" : undefined,
      }}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected}>
        <Flex direction="column" gap="3" align="start" style={{ height: "100%" }}>
          <Flex align="center" justify="between" gap="2" style={{ width: "100%" }}>
            <Flex align="center" gap="2">
              <Box
                style={{
                  alignItems: "center",
                  background: "var(--accent-a3)",
                  borderRadius: 999,
                  color: "var(--accent-11)",
                  display: "inline-flex",
                  height: 28,
                  justifyContent: "center",
                  width: 28,
                }}
              >
                {icon}
              </Box>
              <Text size="2" weight="bold">
                {title}
              </Text>
            </Flex>
            {selected ? <CheckIcon aria-label="Selected" /> : null}
          </Flex>
          <Box>
            <Flex align="center" gap="2" wrap="wrap">
              <Text size="2" weight="medium">
                {model.name}
              </Text>
              <Badge size="1" variant="soft" color={selected ? "purple" : "gray"}>
                {badge}
              </Badge>
            </Flex>
            <Text as="p" size="1" color="gray" mt="1">
              {description}
            </Text>
          </Box>
          <Text size="1" color="gray" mt="auto">
            {availabilityLabel(model)}
          </Text>
          {model.availability.state === "downloading" ? (
            <Box style={{ width: "100%" }}>
              <Progress value={Math.round(model.availability.progress * 100)} size="1" />
              <Text size="1" color="gray" as="p" mt="1">
                {Math.round(model.availability.progress * 100)}% downloaded
              </Text>
            </Box>
          ) : null}
        </Flex>
      </button>
    </Card>
  );
}

/**
 * The recommended first-run path. Experimental providers remain discoverable
 * in the normal model picker instead of competing with the primary setup path.
 */
export function FirstAgentModelChoices({ catalog, value, onChange }: FirstAgentModelChoicesProps) {
  const codex = preferredModel(catalog, CODEX_PROVIDER_ID);
  const selectedProviderId = catalog?.models.find((model) => model.ref === value)?.provider;

  if (!codex) return null;

  return (
    <Flex direction="column" gap="2">
      <Text size="2" weight="medium">
        Recommended provider
      </Text>
      <ModelChoice
        model={codex}
        selected={selectedProviderId === CODEX_PROVIDER_ID}
        icon={<CodeIcon width="14" height="14" />}
        title="GPT Codex"
        badge="Recommended"
        description="Frontier coding and agentic models. Connect your ChatGPT account to use them."
        onSelect={() => onChange(codex.ref)}
      />
    </Flex>
  );
}
