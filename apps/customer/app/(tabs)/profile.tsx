import { formatDominicanPhone } from '@jellyfish/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  Icon,
  Screen,
  SectionHeader,
  Text,
  TextField,
  errorMessage,
  queryClient,
  useSession,
  useTheme,
} from '@jellyfish/mobile-core';
import { LegalList } from '../../src/components/LegalLinks';
import { selectFavoriteCount, useFavorites } from '../../src/store/favorites';
import {
  useAddresses,
  useDeleteAccount,
  useDeleteAddress,
  useMe,
  useUpdateMe,
} from '../../src/api/hooks';

/** Acceso a los favoritos (viven en el teléfono, así que sirve con o sin sesión). */
function FavoritesRow() {
  const { colors } = useTheme();
  const count = useFavorites(selectFavoriteCount);
  return (
    <Pressable
      testID="profile-favorites"
      accessibilityRole="button"
      accessibilityLabel={`Mis favoritos, ${count} guardados`}
      onPress={() => router.push('/favorites')}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 64,
        padding: 14,
        borderRadius: 20,
        backgroundColor: colors.surface,
        borderWidth: 0.5,
        borderColor: colors.border,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View
        style={{
          width: 42,
          height: 42,
          borderRadius: 21,
          backgroundColor: colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="heart-outline" size={22} color={colors.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong">Mis favoritos</Text>
        <Text variant="caption" muted>
          {count === 0
            ? 'Marca productos con el corazón'
            : `${count} ${count === 1 ? 'guardado' : 'guardados'}`}{' '}
          · solo en este teléfono
        </Text>
      </View>
      <Icon name="chevron-right" size={22} color={colors.textMuted} />
    </Pressable>
  );
}

interface Pending {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => void | Promise<void>;
}

export default function Profile() {
  const { colors, palette, spacing } = useTheme();
  const token = useSession((s) => s.token);
  const me = useMe();
  const updateMe = useUpdateMe();
  const addresses = useAddresses();
  const deleteAddress = useDeleteAddress();
  const deleteAccount = useDeleteAccount();
  const [name, setName] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!token) {
    return (
      <Screen>
        <EmptyState
          icon="account-outline"
          title="Crea tu cuenta o inicia sesión"
          text="Con tu número de celular puedes pedir, seguir tus entregas y guardar tus direcciones."
          action="Continuar con mi celular"
          onAction={() => router.push({ pathname: '/login', params: { next: '/profile' } })}
        />
        <FavoritesRow />
        <SectionHeader title="Información legal" />
        <LegalList />
      </Screen>
    );
  }

  const user = me.data;
  const shownName = name ?? user?.name ?? '';
  const dirty = name !== null && name.trim() !== (user?.name ?? '');

  return (
    <Screen>
      <Text variant="display" style={{ marginTop: spacing.md }}>
        Perfil
      </Text>

      <Card style={{ marginTop: spacing.lg, gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 54,
              height: 54,
              borderRadius: 27,
              backgroundColor: colors.surfaceAlt,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="account" size={30} color={colors.glow} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="heading">{user?.name || 'Tu nombre'}</Text>
            <Text muted>{user ? formatDominicanPhone(user.phone) : ''}</Text>
          </View>
        </View>
        <TextField
          label="Nombre"
          value={shownName}
          onChangeText={setName}
          autoCapitalize="words"
          placeholder="Nombre y apellido"
        />
        {dirty ? (
          <Button
            title="Guardar nombre"
            loading={updateMe.isPending}
            onPress={async () => {
              await updateMe.mutateAsync({ name: shownName.trim() });
              setName(null);
            }}
          />
        ) : null}
        {updateMe.isError ? (
          <Text color={palette.danger}>{errorMessage(updateMe.error)}</Text>
        ) : null}
      </Card>

      <View style={{ marginTop: spacing.lg }}>
        <FavoritesRow />
      </View>

      <SectionHeader title="Mis direcciones" />
      <View style={{ gap: 10 }}>
        {(addresses.data ?? []).map((a) => (
          <Card key={a.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Icon name="map-marker-outline" size={24} color={colors.glow} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">
                {a.label} · {a.sector}
                {a.isDefault ? '  ·  Principal' : ''}
              </Text>
              <Text variant="caption" muted>
                {a.line1}
                {a.reference ? ` — ${a.reference}` : ''}
              </Text>
              {a.latitude !== null && a.longitude !== null ? (
                <Text variant="caption" color={palette.success}>
                  Ubicación guardada ✓
                </Text>
              ) : null}
            </View>
            <Button
              title=""
              icon="trash-can-outline"
              variant="ghost"
              small
              onPress={() =>
                setPending({
                  title: '¿Eliminar dirección?',
                  message: `${a.label} · ${a.sector}. ${a.line1}`,
                  confirmLabel: 'Eliminar dirección',
                  run: () => deleteAddress.mutateAsync(a.id).then(() => undefined),
                })
              }
              style={{ paddingHorizontal: 10 }}
            />
          </Card>
        ))}
        <Button
          title="Agregar dirección"
          icon="plus"
          variant="secondary"
          onPress={() => router.push('/address-new')}
        />
      </View>

      <SectionHeader title="Información legal" />
      <LegalList />

      <SectionHeader title="Cuenta" />
      <View style={{ gap: 10 }}>
        <Button
          title="Cerrar sesión"
          variant="secondary"
          icon="logout"
          onPress={async () => {
            await useSession.getState().signOut();
            router.replace('/');
          }}
        />
        <Button
          title="Eliminar mi cuenta"
          variant="ghost"
          icon="trash-can-outline"
          onPress={() =>
            setPending({
              title: '¿Eliminar tu cuenta?',
              message:
                'Borraremos tu perfil, tus direcciones y tus avisos del teléfono. Esto no se puede deshacer. Los pedidos ya hechos se conservan, con su dirección de entrega, por razones contables, pero dejan de estar ligados a tu nombre y a tu teléfono. Tus favoritos y tu carrito viven en este teléfono y no se borran.',
              confirmLabel: 'Sí, eliminar mi cuenta',
              run: async () => {
                await deleteAccount.mutateAsync();
                await useSession.getState().signOut();
                queryClient.clear();
                router.replace('/');
              },
            })
          }
        />
        {deleteAccount.isError ? (
          <Text color={palette.danger}>{errorMessage(deleteAccount.error)}</Text>
        ) : null}
      </View>

      <Text variant="caption" muted center style={{ marginTop: spacing.xl }}>
        JELLYFISH · Versión 0.1.0
      </Text>

      <ConfirmSheet
        visible={pending !== null}
        destructive
        title={pending?.title ?? ''}
        message={pending?.message ?? ''}
        confirmLabel={pending?.confirmLabel ?? ''}
        cancelLabel="No, volver"
        loading={confirming}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (!pending) return;
          setConfirming(true);
          try {
            await pending.run();
            setPending(null);
          } catch {
            // el error se muestra en la pantalla (deleteAccount.isError)
            setPending(null);
          } finally {
            setConfirming(false);
          }
        }}
      />
    </Screen>
  );
}
