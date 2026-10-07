import { formatDominicanPhone } from '@jellyfish/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import { errorMessage } from '../../src/api/client';
import { queryClient } from '../../src/api/query-client';
import {
  useAddresses,
  useDeleteAccount,
  useDeleteAddress,
  useMe,
  useUpdateMe,
} from '../../src/api/hooks';
import { Icon } from '../../src/components/Icon';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  SectionHeader,
  TextField,
} from '../../src/components/ui';
import { useSession } from '../../src/store/session';
import { Text, useTheme } from '../../src/theme';

function confirm(title: string, message: string, onYes: () => void, yes: string) {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title}\n\n${message}`)) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancelar', style: 'cancel' },
    { text: yes, style: 'destructive', onPress: onYes },
  ]);
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
            </View>
            <Button
              title=""
              icon="trash-can-outline"
              variant="ghost"
              small
              onPress={() =>
                confirm(
                  '¿Eliminar dirección?',
                  `${a.label} · ${a.sector}`,
                  () => deleteAddress.mutate(a.id),
                  'Eliminar',
                )
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
            confirm(
              '¿Eliminar tu cuenta?',
              'Borraremos tu perfil y tus direcciones. Esto no se puede deshacer. Conservamos los pedidos que exige la ley, sin tus datos de contacto.',
              async () => {
                try {
                  await deleteAccount.mutateAsync();
                  await useSession.getState().signOut();
                  queryClient.clear();
                  router.replace('/');
                } catch {
                  /* el error se muestra abajo */
                }
              },
              'Eliminar cuenta',
            )
          }
        />
        {deleteAccount.isError ? (
          <Text color={palette.danger}>{errorMessage(deleteAccount.error)}</Text>
        ) : null}
      </View>

      <Text variant="caption" muted center style={{ marginTop: spacing.xl }}>
        JELLYFISH · Versión 0.1.0
      </Text>
    </Screen>
  );
}
