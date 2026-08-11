import type { QuotaProviderKind, QuotaProviderSnapshot, QuotaWindow } from "@t3tools/contracts";
import { formatQuotaReset, formatRemainingPercent } from "@t3tools/shared/quotaFormat";
import { useNavigation } from "@react-navigation/native";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useQuota, type EnvironmentQuotaStatus } from "../../state/quota";
import { SettingsSection } from "../settings/components/SettingsSection";

const PROVIDER_LABEL: Record<QuotaProviderKind, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

export function QuotaRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments, isPending, refresh } = useQuota();
  const refreshing = environments.some(
    (environment) => environment.isPending && environment.snapshot !== null,
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Quota" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {isPending && environments.every((environment) => environment.snapshot === null) ? (
          <Text className="text-base text-foreground-muted">Reading quota…</Text>
        ) : (
          environments.map((environment) => (
            <EnvironmentQuotaSection
              key={environment.environmentId}
              environment={environment}
              showLabel={environments.length > 1}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function EnvironmentQuotaSection(props: {
  readonly environment: EnvironmentQuotaStatus;
  readonly showLabel: boolean;
}) {
  const title = props.showLabel ? props.environment.label : "Subscription";
  if (props.environment.error !== null && props.environment.snapshot === null) {
    return (
      <SettingsSection title={title}>
        <Text className="px-4 py-3 text-base text-foreground-muted">{props.environment.error}</Text>
      </SettingsSection>
    );
  }
  if (props.environment.snapshot === null) {
    return (
      <SettingsSection title={title}>
        <Text className="px-4 py-3 text-base text-foreground-muted">Reading quota…</Text>
      </SettingsSection>
    );
  }

  return (
    <>
      {props.environment.snapshot.providers.map((provider) => (
        <SettingsSection
          key={provider.provider}
          title={
            props.showLabel
              ? `${props.environment.label} · ${providerTitle(provider)}`
              : providerTitle(provider)
          }
        >
          <View className="gap-3 px-4 py-3">
            {provider.windows.length > 0 ? (
              provider.windows.map((window) => <QuotaWindowBlock key={window.id} window={window} />)
            ) : (
              <Text className="text-base text-foreground-muted">
                {provider.message ?? "No subscription windows."}
              </Text>
            )}
            {provider.windows.length > 0 && provider.message !== null ? (
              <Text className="text-sm text-foreground-muted">{provider.message}</Text>
            ) : null}
          </View>
        </SettingsSection>
      ))}
    </>
  );
}

function providerTitle(snapshot: QuotaProviderSnapshot): string {
  return snapshot.planLabel
    ? `${PROVIDER_LABEL[snapshot.provider]} · ${snapshot.planLabel}`
    : PROVIDER_LABEL[snapshot.provider];
}

function QuotaWindowBlock(props: { readonly window: QuotaWindow }) {
  const remaining = Math.max(0, Math.min(100, props.window.remainingPercent));
  const reset = formatQuotaReset(props.window.resetsAt, Date.now());

  return (
    <View className="gap-1">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="shrink text-base text-foreground-muted">{props.window.label}</Text>
        <Text className="text-base tabular-nums text-foreground">
          {formatRemainingPercent(remaining)}
        </Text>
      </View>
      <View className="h-1.5 overflow-hidden rounded-full bg-border">
        <View className="h-full rounded-full bg-foreground" style={{ width: `${remaining}%` }} />
      </View>
      {reset !== null ? <Text className="text-sm text-foreground-muted">{reset}</Text> : null}
    </View>
  );
}
