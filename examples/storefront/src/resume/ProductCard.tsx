import { component } from 'sigx';

/**
 * The workhorse of the page — there are ~48 of these. Fully resumable: no
 * card executes ANY JavaScript until ITS "Add" button is clicked. The first
 * click loads one shared handler chunk (for all cards), replays the click,
 * and the state write upgrades exactly this card's boundary.
 *
 * Cross-boundary communication happens the platform way: the handler
 * dispatches a CustomEvent (globals are resumable captures) and the cart
 * badge island listens.
 */
export const ProductCard = component<{ id: string; name: string; emoji: string; price: number }>((ctx) => {
    const qty = ctx.signal(0);
    return () => (
        <article class="card">
            <span class="art">{ctx.props.emoji}</span>
            <h4>{ctx.props.name}</h4>
            <p class="price">${ctx.props.price}</p>
            <button
                onClick={() => {
                    qty.value++;
                    window.dispatchEvent(new CustomEvent('cart:add', {
                        detail: { id: ctx.props.id, price: ctx.props.price }
                    }));
                }}
            >
                {qty.value === 0 ? 'Add to cart' : `In cart ×${qty.value}`}
            </button>
        </article>
    );
});
