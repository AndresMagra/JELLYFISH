import { formatDOP } from '@jellyfish/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import {
  Badge,
  BottomSheet,
  Button,
  Text,
  errorMessage,
  quantityLabel,
  reorderSummaryText,
  success,
  useTheme,
  type ReorderItem,
  type ReorderPlan,
} from '@jellyfish/mobile-core';
import { useReorder } from '../api/hooks';
import { useCart } from '../store/cart';
import { ProductImage } from './ProductImage';

const BADGE = {
  added: { label: 'Agregado', tone: 'success' },
  reduced: { label: 'Menos cantidad', tone: 'warning' },
  unavailable: { label: 'Sin existencia', tone: 'danger' },
} as const;

function ItemRow({ item }: { item: ReorderItem }) {
  const { colors } = useTheme();
  const b = BADGE[item.outcome];
  const off = item.outcome === 'unavailable';
  return (
    <View
      style={{ flexDirection: 'row', gap: 12, paddingVertical: 8, alignItems: 'center' }}
      testID={`reorder-item-${item.outcome}`}
    >
      <ProductImage
        category={item.product?.category ?? 'otros'}
        photo={item.line.photo}
        frozen={false}
        radius={12}
        iconSize={20}
        style={{ width: 52, height: 52, opacity: off ? 0.5 : 1 }}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong" numberOfLines={2} muted={off}>
          {item.line.name}
          {item.line.variant ? ` · ${item.line.variant}` : ''}
        </Text>
        {!off ? (
          <Text variant="caption" muted>
            {quantityLabel(item.line.pricingUnit, item.quantity)} · {formatDOP(item.line.unitPrice)}
            {item.line.pricingUnit === 'lb' ? ' /lb' : ''}
          </Text>
        ) : null}
        {item.note ? (
          <Text variant="caption" color={off ? colors.textMuted : colors.text}>
            {item.note}
          </Text>
        ) : null}
      </View>
      <Badge label={b.label} tone={b.tone} />
    </View>
  );
}

interface Props {
  orderId: string;
  title?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  small?: boolean;
  testID?: string;
}

/**
 * "Pedir de nuevo": agrega al carrito lo que se pueda del pedido anterior y muestra qué se agregó,
 * qué quedó con menos cantidad y qué ya no hay, antes de ir al carrito.
 */
export function ReorderButton({
  orderId,
  title = 'Pedir de nuevo',
  variant = 'secondary',
  small,
  testID = 'reorder',
}: Props) {
  const reorder = useReorder();
  const addMany = useCart((s) => s.addMany);
  const [plan, setPlan] = useState<ReorderPlan | null>(null);
  const [open, setOpen] = useState(false);

  const run = async () => {
    setPlan(null);
    reorder.reset();
    try {
      const p = await reorder.mutateAsync(orderId);
      if (p.toAdd.length > 0) {
        addMany(
          p.toAdd.map((i) => ({ product: i.product!, variant: i.variant!, quantity: i.quantity })),
        );
        success();
      }
      setPlan(p);
    } catch {
      /* el error se muestra en la hoja */
    }
    setOpen(true);
  };

  const close = () => setOpen(false);
  const goCart = () => {
    setOpen(false);
    router.push('/cart');
  };

  const added = plan ? plan.toAdd.length : 0;
  return (
    <>
      <Button
        title={title}
        icon="cart-arrow-down"
        variant={variant}
        small={small}
        loading={reorder.isPending}
        onPress={run}
        testID={testID}
      />
      <BottomSheet
        visible={open}
        onClose={close}
        testID="reorder-sheet"
        icon={reorder.isError ? 'alert-circle-outline' : added > 0 ? 'cart-check' : 'cart-off'}
        title={
          reorder.isError
            ? 'No pudimos preparar tu pedido'
            : added > 0
              ? 'Listo, ya están en tu carrito'
              : 'No pudimos agregar nada'
        }
        subtitle={
          reorder.isError
            ? errorMessage(reorder.error)
            : plan
              ? reorderSummaryText(plan.summary)
              : undefined
        }
        footer={
          reorder.isError ? (
            <>
              <Button title="Intentar de nuevo" onPress={run} loading={reorder.isPending} />
              <Button title="Cerrar" variant="ghost" onPress={close} />
            </>
          ) : added > 0 ? (
            <>
              <Button
                title="Ir al carrito"
                icon="cart-outline"
                onPress={goCart}
                testID="reorder-go-cart"
              />
              <Button title="Seguir comprando" variant="ghost" onPress={close} />
            </>
          ) : (
            <>
              <Button
                title="Ver productos"
                onPress={() => {
                  close();
                  router.push('/search');
                }}
              />
              <Button title="Cerrar" variant="ghost" onPress={close} />
            </>
          )
        }
      >
        {plan?.items.map((it) => (
          <ItemRow key={it.line.variantId} item={it} />
        ))}
        {plan && plan.summary.priceChanged > 0 ? (
          <Text variant="caption" muted>
            Los precios son los de hoy: pueden ser distintos a los de tu pedido anterior.
          </Text>
        ) : null}
      </BottomSheet>
    </>
  );
}
