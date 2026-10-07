import type { AddressInput } from '@jellyfish/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '../src/api/client';
import { useCreateAddress, useZoneCheck } from '../src/api/hooks';
import { Header } from '../src/components/Header';
import { Icon } from '../src/components/Icon';
import { Badge, Button, Card, Chip, FooterBar, TextField } from '../src/components/ui';
import { Text, useTheme } from '../src/theme';

const LABELS = ['Casa', 'Trabajo', 'Otro'];

export default function NewAddress() {
  const { colors, palette, spacing } = useTheme();
  const [label, setLabel] = useState('Casa');
  const [line1, setLine1] = useState('');
  const [sector, setSector] = useState('');
  const [city, setCity] = useState('Santo Domingo');
  const [reference, setReference] = useState('');
  const [touched, setTouched] = useState(false);
  const create = useCreateAddress();
  const zone = useZoneCheck(sector, city);

  const errors = {
    line1: line1.trim().length < 3 ? 'Escribe la calle y el número' : null,
    sector: sector.trim().length < 2 ? 'Indica tu sector' : null,
    city: city.trim().length < 2 ? 'Indica tu ciudad' : null,
  };
  const valid = !errors.line1 && !errors.sector && !errors.city;

  const save = async () => {
    setTouched(true);
    if (!valid) return;
    const input: AddressInput = {
      label,
      line1: line1.trim(),
      reference: reference.trim(),
      sector: sector.trim(),
      city: city.trim(),
    };
    try {
      await create.mutateAsync(input);
      router.back();
    } catch {
      /* se muestra abajo */
    }
  };

  const covered = zone.data?.covered;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
          keyboardShouldPersistTaps="handled"
        >
          <Header title="Nueva dirección" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {LABELS.map((l) => (
              <Chip key={l} label={l} selected={label === l} onPress={() => setLabel(l)} />
            ))}
          </View>
          <TextField
            label="Calle y número"
            value={line1}
            onChangeText={setLine1}
            placeholder="Ej: Calle Max Henríquez Ureña #10"
            error={touched ? errors.line1 : null}
            testID="addr-line1"
          />
          <TextField
            label="Sector"
            value={sector}
            onChangeText={setSector}
            placeholder="Ej: Naco, Piantini, Los Prados"
            error={touched ? errors.sector : null}
            testID="addr-sector"
          />
          <TextField
            label="Ciudad"
            value={city}
            onChangeText={setCity}
            error={touched ? errors.city : null}
            testID="addr-city"
          />
          <TextField
            label="Referencia para el repartidor"
            value={reference}
            onChangeText={setReference}
            multiline
            placeholder="Ej: al lado del colmado Don Pepe, portón negro, apto 3B"
            hint="En RD las direcciones no siempre son exactas: una buena referencia nos ayuda a llegar rápido."
            testID="addr-reference"
          />

          {zone.data ? (
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Icon
                name={covered ? 'check-circle' : 'map-marker-outline'}
                size={26}
                color={covered ? palette.success : palette.warning}
              />
              <View style={{ flex: 1, gap: 4 }}>
                {zone.data.covered ? (
                  <>
                    <Text variant="bodyStrong">¡Llegamos a tu sector!</Text>
                    <Badge label={zone.data.zone.name} tone="success" />
                  </>
                ) : (
                  <>
                    <Text variant="bodyStrong">Aún no llegamos aquí</Text>
                    <Text variant="caption" muted>
                      Puedes guardarla; te avisaremos cuando lleguemos a tu zona.
                    </Text>
                  </>
                )}
              </View>
            </Card>
          ) : null}

          {create.isError ? <Text color={palette.danger}>{errorMessage(create.error)}</Text> : null}
        </ScrollView>
        <FooterBar>
          <Button
            title="Guardar dirección"
            onPress={save}
            loading={create.isPending}
            testID="save-address"
          />
        </FooterBar>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
