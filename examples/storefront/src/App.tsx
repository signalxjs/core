import { component, useData } from 'sigx';
import { categorySlugs, loadCategory, type Category } from './catalog';
import { ProductCard } from './resume/ProductCard';
import { Newsletter } from './resume/Newsletter';
import { DealOfTheDay } from './resume/DealOfTheDay';
import { CartBadge } from './islands/CartBadge';
import { JsHud } from './islands/JsHud';

/**
 * One streamed category section. The section itself is a plain async
 * component (keyed useData → core streams a placeholder, then the
 * replacement) — the resumable cards inside are interactive the moment the
 * replacement lands, no hydration pass required.
 */
const Section = component<{ slug: string }>((ctx) => {
    const data = useData(`category:${ctx.props.slug}`, () => loadCategory(ctx.props.slug));
    return () => {
        const category = data.value as Category | undefined;
        if (!category) {
            return <section class="category skeleton"><h2>Loading…</h2></section>;
        }
        return (
            <section class="category">
                <h2>{category.title} <small>{category.blurb}</small></h2>
                <div class="grid">
                    {category.products.map((product) => (
                        <ProductCard
                            key={product.id}
                            id={product.id}
                            name={product.name}
                            emoji={product.emoji}
                            price={product.price}
                        />
                    ))}
                </div>
            </section>
        );
    };
}, { name: 'Section' });

export const App = component(() => {
    const rendered = new Date().toISOString();
    return () => (
        <div class="shop">
            <header>
                <h1>SignalX Storefront</h1>
                <CartBadge client:load />
            </header>

            <p class="tagline">
                ~48 interactive product cards, one interactive form, one deal
                widget — and the only JavaScript this page executes on load is
                a sub-kilobyte delegation loader plus the two deliberate
                islands you can see (cart badge, HUD). Rendered {rendered}.
            </p>

            <DealOfTheDay />

            {categorySlugs().map((slug) => <Section key={slug} slug={slug} />)}

            <footer>
                <h3>Stay in the loop</h3>
                <Newsletter />
            </footer>

            <JsHud client:idle />
        </div>
    );
}, { name: 'App' });
