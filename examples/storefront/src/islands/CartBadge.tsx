import { component } from 'sigx';

/**
 * The one place that genuinely needs live JavaScript at page load: the cart
 * badge must react to add-to-cart events from ANY card, immediately. That's
 * an island (`client:load`) — a deliberate choice of where to spend JS.
 * Everything it listens to comes over plain CustomEvents, so the resumable
 * cards never import it (and vice versa).
 */
export const CartBadge = component((ctx) => {
    const count = ctx.signal(0);
    const total = ctx.signal(0);

    ctx.onMounted(() => {
        const onAdd = (e: Event) => {
            const detail = (e as CustomEvent<{ price: number }>).detail;
            count.value++;
            total.value += detail?.price ?? 0;
        };
        window.addEventListener('cart:add', onAdd);
        ctx.onUnmounted(() => window.removeEventListener('cart:add', onAdd));
    });

    return () => (
        <span class="badge" title={`$${total.value}`}>
            🛒 {count.value === 0 ? 'empty' : `${count.value} · $${total.value}`}
        </span>
    );
});
