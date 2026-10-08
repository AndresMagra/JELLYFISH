import type { CategoryDTO, ProductDTO } from '@jellyfish/shared';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { useCategories, useProducts } from '../../src/api/hooks';
import {
  Badge,
  ErrorState,
  Icon,
  IconButton,
  Screen,
  SectionHeader,
  Skeleton,
  Text,
  errorMessage,
  fonts,
  tap,
  useSession,
  useTheme,
} from '@jellyfish/mobile-core';
import { resolveFavorites } from '@jellyfish/mobile-core';
import { CategoryGlyph, categoryLook } from '../../src/components/CategoryIcon';
import { ProductCard } from '../../src/components/ProductCard';
import { selectCount, useCart } from '../../src/store/cart';
import { useFavorites } from '../../src/store/favorites';

const CARD_W = 158;

function Hero() {
  const { palette, radii } = useTheme();
  return (
    <LinearGradient
      colors={[palette.tide, palette.deep, palette.abyss]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{
        borderRadius: radii.xl,
        padding: 22,
        overflow: 'hidden',
        minHeight: 176,
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          position: 'absolute',
          right: -34,
          top: -30,
          width: 190,
          height: 190,
          borderRadius: 95,
          backgroundColor: palette.cyan,
          opacity: 0.14,
        }}
      />
      <View
        style={{
          position: 'absolute',
          right: 40,
          bottom: -40,
          width: 110,
          height: 110,
          borderRadius: 55,
          backgroundColor: palette.coral,
          opacity: 0.16,
        }}
      />
      <View style={{ position: 'absolute', right: 20, top: 26, opacity: 0.9 }}>
        <Icon name="jellyfish" size={76} color={palette.cyanSoft} />
      </View>
      <Badge label="Cadena de frío garantizada" tone="info" />
      <Text variant="display" color="#fff" style={{ marginTop: 12, maxWidth: '66%' }}>
        Congelados de primera, a tu puerta
      </Text>
      <Text color={palette.frost} style={{ marginTop: 6, maxWidth: '66%' }}>
        Res, cerdo, pollo, pescados y mariscos.
      </Text>
    </LinearGradient>
  );
}

function CategoryRow({ categories }: { categories: CategoryDTO[] }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 14, paddingVertical: 4 }}
    >
      {categories.map((c) => {
        const look = categoryLook(c.slug);
        return (
          <Pressable
            key={c.slug}
            accessibilityRole="button"
            accessibilityLabel={`Categoría ${c.name}`}
            onPress={() => {
              tap();
              router.push({ pathname: '/search', params: { category: c.slug } });
            }}
            style={({ pressed }) => ({
              alignItems: 'center',
              gap: 8,
              width: 74,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <LinearGradient
              colors={look.gradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <CategoryGlyph slug={c.slug} size={26} />
            </LinearGradient>
            <Text
              variant="caption"
              color={colors.text}
              center
              numberOfLines={2}
              style={{ fontFamily: fonts.semibold }}
            >
              {c.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function TrustRow() {
  const { colors, spacing } = useTheme();
  const items: { icon: Parameters<typeof Icon>[0]['name']; title: string; text: string }[] = [
    { icon: 'snowflake', title: 'Cadena de frío', text: 'Empacado con hielo' },
    { icon: 'clock-outline', title: 'Tú eliges la hora', text: 'Entrega programada' },
    { icon: 'shield-check', title: 'Pago seguro', text: 'Tarjeta, efectivo o transferencia' },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl }}>
      {items.map((it) => (
        <View
          key={it.title}
          style={{
            flex: 1,
            backgroundColor: colors.surface,
            borderRadius: 18,
            padding: 12,
            gap: 6,
            borderWidth: 0.5,
            borderColor: colors.border,
          }}
        >
          <Icon name={it.icon} size={22} color={colors.glow} />
          <Text variant="caption" style={{ fontFamily: fonts.bold }}>
            {it.title}
          </Text>
          <Text variant="caption" muted>
            {it.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Rail({ category, products }: { category: CategoryDTO; products: ProductDTO[] }) {
  return (
    <View>
      <SectionHeader
        title={category.name}
        action="Ver todo"
        onAction={() => router.push({ pathname: '/search', params: { category: category.slug } })}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 12 }}
      >
        {products.slice(0, 10).map((p) => (
          <ProductCard key={p.group} product={p} width={CARD_W} />
        ))}
      </ScrollView>
    </View>
  );
}

/** "Tus favoritos": los productos que marcó con el corazón (solo viven en este teléfono). */
function FavoritesRail({ products }: { products: ProductDTO[] }) {
  const { colors } = useTheme();
  return (
    <View testID="favorites-rail">
      <SectionHeader
        title="Tus favoritos"
        action="Ver todos"
        onAction={() => router.push('/favorites')}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginTop: -6,
          marginBottom: 10,
        }}
      >
        <Icon name="cellphone" size={14} color={colors.textMuted} />
        <Text variant="caption" muted>
          Guardados en este teléfono
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 12 }}
      >
        {products.slice(0, 10).map((p) => (
          <ProductCard key={p.group} product={p} width={CARD_W} />
        ))}
      </ScrollView>
    </View>
  );
}

export default function Home() {
  const { colors, palette, spacing } = useTheme();
  const cats = useCategories();
  const products = useProducts({ limit: 100 });
  const cartCount = useCart(selectCount);
  const name = useSession((s) => s.user?.name);
  const favoriteGroups = useFavorites((s) => s.groups);
  const favorites = resolveFavorites(favoriteGroups, products.data?.items ?? []);

  const byCategory = new Map<string, ProductDTO[]>();
  for (const p of products.data?.items ?? [])
    byCategory.set(p.category, [...(byCategory.get(p.category) ?? []), p]);
  const visibleCats = (cats.data ?? []).filter((c) => (byCategory.get(c.slug)?.length ?? 0) > 0);

  return (
    <Screen>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingTop: spacing.md,
          paddingBottom: spacing.lg,
          gap: spacing.md,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text variant="caption" muted>
            {name ? `Hola, ${name.split(' ')[0]}` : 'Hola 👋'}
          </Text>
          <Text variant="title">JELLYFISH</Text>
        </View>
        <IconButton
          icon="cart-outline"
          label="Carrito"
          badge={cartCount}
          onPress={() => router.push('/cart')}
        />
      </View>

      <Pressable
        accessibilityRole="search"
        onPress={() => router.push('/search')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: colors.surface,
          borderRadius: 18,
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderWidth: 0.5,
          borderColor: colors.border,
          marginBottom: spacing.lg,
        }}
      >
        <Icon name="magnify" size={22} color={colors.textMuted} />
        <Text muted>Busca pechuga, camarones, costilla…</Text>
      </Pressable>

      {products.data?.demo ? (
        <View
          style={{
            backgroundColor: palette.warning,
            borderRadius: 14,
            padding: 10,
            marginBottom: spacing.md,
          }}
        >
          <Text variant="caption" color="#1B1300" style={{ fontFamily: fonts.bold }}>
            MODO DEMOSTRACIÓN · Los pedidos son de prueba: no se entregan ni se cobran.
          </Text>
        </View>
      ) : null}

      <Hero />

      <SectionHeader title="Categorías" />
      {cats.isLoading ? (
        <Skeleton height={92} />
      ) : cats.data ? (
        <CategoryRow categories={cats.data} />
      ) : null}

      <TrustRow />

      {favorites.length > 0 ? <FavoritesRail products={favorites} /> : null}

      {products.isLoading ? (
        <View style={{ gap: 12, marginTop: spacing.xl }}>
          <Skeleton height={26} width="40%" />
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <Skeleton height={230} width={CARD_W} radius={24} />
            <Skeleton height={230} width={CARD_W} radius={24} />
          </View>
        </View>
      ) : products.isError ? (
        <ErrorState
          message={errorMessage(products.error)}
          onRetry={() => void products.refetch()}
        />
      ) : visibleCats.length === 0 ? (
        <View style={{ marginTop: spacing.xl }}>
          <ErrorState message="Todavía no hay productos disponibles. Vuelve pronto." />
        </View>
      ) : (
        visibleCats.map((c) => (
          <Rail key={c.slug} category={c} products={byCategory.get(c.slug) ?? []} />
        ))
      )}
    </Screen>
  );
}
