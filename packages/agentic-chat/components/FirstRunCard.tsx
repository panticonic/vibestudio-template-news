import { Badge, Box, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { HomeIcon, LockClosedIcon } from "@radix-ui/react-icons";

/**
 * First-run narrative card (design §9, item 9). Shown as the empty-transcript
 * state of a brand-new chat: it explains, once and unobtrusively, that this
 * workspace can use a connected provider. It disappears the
 * moment the first message lands, so it never competes with real content.
 */
export function FirstRunCard() {
  return (
    <Flex align="center" justify="center" style={{ height: "100%", padding: 24 }}>
      <Card size="3" style={{ maxWidth: 460, width: "100%" }}>
        <Flex direction="column" gap="3">
          <Flex align="center" gap="2">
            <HomeIcon width="18" height="18" />
            <Heading size="4">Chat runs on your terms</Heading>
          </Flex>
          <Text size="2" color="gray">
            Connect a model provider from the model picker to get started. Your first message waits
            for your choice; Vibestudio will not silently download a model or attribute an
            onboarding prompt to you.
          </Text>
          <Box>
            <Flex direction="column" gap="2">
              <Feature
                icon={<HomeIcon width="14" height="14" />}
                color="green"
                title="Choose a provider"
                body="Use the model picker to connect OpenAI, Anthropic, or another configured provider. If a request cannot run, the chat shows a connection card."
              />
              <Feature
                icon={<LockClosedIcon width="14" height="14" />}
                color="blue"
                title="Your credentials stay protected"
                body="Keys stay in Vibestudio's credential store. You can switch providers and models from the model picker at any time."
              />
            </Flex>
          </Box>
        </Flex>
      </Card>
    </Flex>
  );
}

function Feature({
  icon,
  color,
  title,
  body,
}: {
  icon: React.ReactNode;
  color: "green" | "blue";
  title: string;
  body: string;
}) {
  return (
    <Flex gap="3" align="start">
      <Badge color={color} variant="soft" size="1" style={{ marginTop: 2, flexShrink: 0 }}>
        {icon}
      </Badge>
      <Box style={{ minWidth: 0 }}>
        <Text size="2" weight="medium" as="p">
          {title}
        </Text>
        <Text size="1" color="gray" as="p">
          {body}
        </Text>
      </Box>
    </Flex>
  );
}
