import { formatLegalDate, isLegalDocId, renderLegalDoc, type LegalBlock } from '@jellyfish/shared';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ErrorState, Header, Text, useTheme } from '@jellyfish/mobile-core';
import { LegalDraftBanner, LegalList, LegalText } from '../../src/components/LegalLinks';

function Block({ block }: { block: LegalBlock }) {
  const { colors } = useTheme();
  if (typeof block === 'string') return <LegalText text={block} />;
  return (
    <View style={{ gap: 8 }}>
      {block.list.map((item, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 10, paddingRight: 4 }}>
          <Text color={colors.glow} style={{ lineHeight: 24 }}>
            •
          </Text>
          <View style={{ flex: 1 }}>
            <LegalText text={item} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Un documento legal: encabezado, fecha de actualización y secciones. */
export default function LegalDocScreen() {
  const { doc } = useLocalSearchParams<{ doc: string }>();
  const { colors, spacing } = useTheme();

  if (!isLegalDocId(doc)) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg }}>
        <Header title="Documento" />
        <ErrorState message="No encontramos este documento." />
      </SafeAreaView>
    );
  }

  const d = renderLegalDoc(doc);
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <ScrollView
        contentContainerStyle={{
          padding: spacing.lg,
          gap: spacing.lg,
          paddingBottom: spacing.xxl * 2,
          maxWidth: 720,
          width: '100%',
          alignSelf: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        <Header title="Legal" />
        <View style={{ gap: 6 }}>
          <Text variant="display" accessibilityRole="header" testID="legal-title">
            {d.title}
          </Text>
          <Text variant="caption" muted testID="legal-updated">
            Actualizado el {formatLegalDate(d.updatedAt)}
          </Text>
        </View>
        <LegalDraftBanner />
        {d.sections.map((s) => (
          <View key={s.heading} style={{ gap: 10 }}>
            <Text variant="title" accessibilityRole="header">
              {s.heading}
            </Text>
            {s.blocks.map((b, i) => (
              <Block key={i} block={b} />
            ))}
          </View>
        ))}
        <View style={{ gap: 10, marginTop: spacing.md }}>
          <Text variant="label" muted>
            Otros documentos
          </Text>
          <LegalList except={doc} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
