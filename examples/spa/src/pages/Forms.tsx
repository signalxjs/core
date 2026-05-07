import { component, type Define } from 'sigx';

// Child component: takes a required `label` prop, emits a `step` event with a number.
// The parent reads this event as `onStep`. Demonstrates Define.Prop + Define.Event.
type StepperProps =
    & Define.Prop<'label', string, true>
    & Define.Event<'step', number>;

const Stepper = component<StepperProps>(({ props, emit }) => {
    return () => (
        <div style="display: flex; align-items: center; gap: 0.75rem;">
            <span>{props.label}</span>
            <button onClick={() => emit('step', -1)}>−</button>
            <button onClick={() => emit('step', +1)}>+</button>
        </div>
    );
});

// Child component: accepts a two-way model binding of type number.
// Inside, read/write through props.model.value. Demonstrates Define.Model.
type RatingProps = Define.Model<number>;

const Rating = component<RatingProps>(({ props }) => {
    const buttonStyle = 'background: none; border: none; padding: 0; cursor: pointer; font-size: 1.6rem; line-height: 1;';
    return () => (
        <div style="display: flex; gap: 0.25rem;">
            {[1, 2, 3, 4, 5].map(n => (
                <button
                    type="button"
                    style={buttonStyle}
                    onClick={() => { if (props.model) props.model.value = n; }}
                >
                    <span style={`color: ${n <= (props.model?.value ?? 0) ? '#f59e0b' : '#d1d5db'};`}>★</span>
                </button>
            ))}
        </div>
    );
});

export const Forms = component(({ signal }) => {
    const state = signal({
        name: '',
        agreed: false,
        country: 'us',
        bio: '',
        rating: 3,
        count: 0
    });

    return () => (
        <>
            <h1>Forms & bindings</h1>
            <p>Native <code>model</code> directive, child components with <code>Define.Prop</code> / <code>Define.Event</code>, and custom <code>Define.Model</code>.</p>

            <div class="card">
                <h3 style="margin-top: 0;">Native two-way binding</h3>
                <p style="color: #555;"><code>model={'{() => state.x}'}</code> works on form elements out of the box.</p>
                <div style="display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1rem;">
                    <input model={() => state.name} placeholder="Your name" />
                    <label style="display: flex; align-items: center; gap: 0.5rem;">
                        <input type="checkbox" model={() => state.agreed} /> I agree
                    </label>
                    <select model={() => state.country}>
                        <option value="us">United States</option>
                        <option value="uk">United Kingdom</option>
                        <option value="se">Sweden</option>
                    </select>
                    <textarea model={() => state.bio} placeholder="Bio" rows={3} />
                </div>
                <p style="margin-top: 1rem;">
                    Hello, <strong>{state.name || '(stranger)'}</strong> from <strong>{state.country}</strong>. Agreed: <strong>{state.agreed ? 'yes' : 'no'}</strong>. Bio length: <strong>{state.bio.length}</strong>.
                </p>
            </div>

            <div class="card">
                <h3 style="margin-top: 0;">Props & events (child → parent)</h3>
                <p style="color: #555;">
                    The Stepper child is typed with <code>Define.Prop&lt;'label', string, true&gt;</code> and <code>Define.Event&lt;'step', number&gt;</code>. The parent owns the state and updates it from the emitted event.
                </p>
                <div style="margin-top: 1rem;">
                    <Stepper
                        label={`Count: ${state.count}`}
                        onStep={(delta: number) => { state.count += delta; }}
                    />
                </div>
            </div>

            <div class="card">
                <h3 style="margin-top: 0;">Two-way <code>model</code> on a custom component</h3>
                <p style="color: #555;">
                    The Rating child is typed with <code>Define.Model&lt;number&gt;</code>. The parent passes <code>model={'{() => state.rating}'}</code>; inside, the child reads and writes <code>props.model.value</code>.
                </p>
                <div style="margin-top: 1rem; display: flex; align-items: center; gap: 1rem;">
                    <Rating model={() => state.rating} />
                    <span>Rated: <strong>{state.rating}</strong> / 5</span>
                </div>
            </div>
        </>
    );
});
