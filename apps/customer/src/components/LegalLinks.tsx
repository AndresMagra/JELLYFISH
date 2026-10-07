import {
  LEGAL_DOCS,
  LEGAL_DOC_IDS,
  LEGAL_DRAFT,
  LEGAL_UPDATED_AT,
  PENDING,
  formatLegalDate,
  renderLegalDoc,
  type LegalDocId,
} from '@jellyfish/shared';
import { router } from 'expo-router';
import { Platform, Pressable, View } from 'react-native';
import { Icon, Text, fonts, tap, useTheme } from '@jellyfish/mobile-core';

export function openLegal(doc: LegalDocId) {
  router.push({ pathname: '/legal/[doc]', params: { doc } });
}

/** Enlace dentro de una frase ("Términos y condiciones"). */
export function LegalLink({ doc, label }: { doc: LegalDocId; label?: string }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole="link"
      onPress={() => {
        tap();
        openLegal(doc);
      }}
      color={colors.glow}
      testID={`legal-link-${doc}`}
      style={{ fontFamily: fonts.semibold, textDecorationLine: 'underline' }}
    >
      {label ?? LEGAL_DOCS[doc].title}
    </Text>
  );
}

/**
 * "Al continuar aceptas los Términos y la Política de privacidad" (login y verificación).
 * En el login también avisa del SMS, que es lo que decía el texto genérico que reemplaza.
 */
export function LegalAcceptNotice({ sms }: { sms?: boolean }) {
  return (
    <Text variant="caption" muted center style={{ lineHeight: 20 }} testID="legal-accept">
      {sms ? 'Te enviaremos un SMS con tu código; pueden aplicar tarifas de tu operadora. ' : null}
      Al continuar aceptas los <LegalLink doc="terminos" label="Términos y condiciones" /> y la{' '}
      <LegalLink doc="privacidad" label="Política de privacidad" />.
    </Text>
  );
}

/** Aviso bajo el botón de confirmar el pedido. */
export function LegalCheckoutNotice() {
  return (
    <Text variant="caption" muted center style={{ lineHeight: 20 }} testID="legal-checkout">
      Al confirmar aceptas los <LegalLink doc="terminos" label="Términos y condiciones" /> y la
      política de <LegalLink doc="devoluciones" label="Devoluciones y reembolsos" />.
    </Text>
  );
}

/** Franja que avisa que los textos todavía no los revisó un abogado (hasta que LEGAL_DRAFT sea false). */
export function LegalDraftBanner() {
  const { palette } = useTheme();
  if (!LEGAL_DRAFT) return null;
  return (
    <View
      testID="legal-draft"
      accessibilityRole="alert"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: palette.warning,
        borderRadius: 14,
        paddingVertical: 10,
        paddingHorizontal: 12,
      }}
    >
      <Icon name="file-document-alert-outline" size={22} color="#1B1300" />
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong" color="#1B1300">
          Borrador pendiente de revisión legal
        </Text>
        <Text variant="caption" color="#3A2A00">
          Este texto puede cambiar antes de abrir al público.
        </Text>
      </View>
    </View>
  );
}

/** Lista de los documentos legales (Perfil y pie de la pantalla de cada documento). */
export function LegalList({ except }: { except?: LegalDocId }) {
  const { colors } = useTheme();
  const ids = LEGAL_DOC_IDS.filter((id) => id !== except);
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 20,
        borderWidth: 0.5,
        borderColor: colors.border,
        overflow: 'hidden',
      }}
    >
      {ids.map((id, i) => {
        const doc = renderLegalDoc(id);
        return (
          <Pressable
            key={id}
            testID={`legal-row-${id}`}
            accessibilityRole="button"
            accessibilityLabel={doc.title}
            onPress={() => {
              tap();
              openLegal(id);
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              minHeight: 56,
              paddingVertical: 12,
              paddingHorizontal: 16,
              borderTopWidth: i === 0 ? 0 : 0.5,
              borderTopColor: colors.border,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name="file-document-outline" size={22} color={colors.glow} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{doc.title}</Text>
              <Text variant="caption" muted numberOfLines={2}>
                {doc.summary}
              </Text>
            </View>
            <Icon name="chevron-right" size={22} color={colors.textMuted} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** Texto con los "[por definir]" resaltados, para que se vea qué datos del negocio faltan. */
export function LegalText({ text, strong }: { text: string; strong?: boolean }) {
  const { palette, dark } = useTheme();
  const parts = text.split(PENDING);
  return (
    <Text
      style={{
        lineHeight: 24,
        ...(strong ? { fontFamily: fonts.semibold } : null),
        ...(Platform.OS === 'web' ? ({ userSelect: 'text' } as object) : null),
      }}
    >
      {parts.map((part, i) => (
        <Text key={i}>
          {part}
          {i < parts.length - 1 ? (
            <Text
              style={{
                fontFamily: fonts.bold,
                color: dark ? '#FFD479' : '#8A5300',
                backgroundColor: dark ? 'rgba(245,158,11,0.18)' : 'rgba(245,158,11,0.22)',
              }}
            >
              {PENDING}
            </Text>
          ) : null}
        </Text>
      ))}
    </Text>
  );
}

export const legalUpdatedLabel = `Actualizado el ${formatLegalDate(LEGAL_UPDATED_AT)}`;
