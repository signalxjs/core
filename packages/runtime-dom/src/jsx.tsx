import '@sigx/runtime-core';
import type { Model } from '@sigx/runtime-core';

// Custom CSS properties type that allows both string and number for numeric properties
type CSSNumericProperty = string | number;

interface CSSProperties {
    // Positioning
    position?: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky' | (string & {});
    top?: CSSNumericProperty;
    right?: CSSNumericProperty;
    bottom?: CSSNumericProperty;
    left?: CSSNumericProperty;
    zIndex?: CSSNumericProperty;
    
    // Box Model
    width?: CSSNumericProperty;
    height?: CSSNumericProperty;
    minWidth?: CSSNumericProperty;
    maxWidth?: CSSNumericProperty;
    minHeight?: CSSNumericProperty;
    maxHeight?: CSSNumericProperty;
    margin?: CSSNumericProperty;
    marginTop?: CSSNumericProperty;
    marginRight?: CSSNumericProperty;
    marginBottom?: CSSNumericProperty;
    marginLeft?: CSSNumericProperty;
    padding?: CSSNumericProperty;
    paddingTop?: CSSNumericProperty;
    paddingRight?: CSSNumericProperty;
    paddingBottom?: CSSNumericProperty;
    paddingLeft?: CSSNumericProperty;
    
    // Flexbox
    display?: string;
    flexDirection?: 'row' | 'row-reverse' | 'column' | 'column-reverse' | (string & {});
    flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse' | (string & {});
    justifyContent?: string;
    alignItems?: string;
    alignContent?: string;
    alignSelf?: string;
    flex?: CSSNumericProperty;
    flexGrow?: CSSNumericProperty;
    flexShrink?: CSSNumericProperty;
    flexBasis?: CSSNumericProperty;
    order?: CSSNumericProperty;
    gap?: CSSNumericProperty;
    rowGap?: CSSNumericProperty;
    columnGap?: CSSNumericProperty;
    
    // Grid
    gridTemplateColumns?: string;
    gridTemplateRows?: string;
    gridColumn?: string;
    gridRow?: string;
    gridArea?: string;
    gridGap?: CSSNumericProperty;
    
    // Typography
    fontSize?: CSSNumericProperty;
    fontFamily?: string;
    fontWeight?: CSSNumericProperty;
    fontStyle?: string;
    lineHeight?: CSSNumericProperty;
    letterSpacing?: CSSNumericProperty;
    textAlign?: 'left' | 'center' | 'right' | 'justify' | (string & {});
    textDecoration?: string;
    textTransform?: string;
    whiteSpace?: string;
    wordBreak?: string;
    wordWrap?: string;
    overflowWrap?: string;
    
    // Colors & Background
    color?: string;
    backgroundColor?: string;
    background?: string;
    backgroundImage?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
    
    // Border
    border?: string;
    borderWidth?: CSSNumericProperty;
    borderStyle?: string;
    borderColor?: string;
    borderRadius?: CSSNumericProperty;
    borderTop?: string;
    borderRight?: string;
    borderBottom?: string;
    borderLeft?: string;
    
    // Effects
    opacity?: CSSNumericProperty;
    visibility?: 'visible' | 'hidden' | 'collapse' | (string & {});
    overflow?: 'visible' | 'hidden' | 'scroll' | 'auto' | (string & {});
    overflowX?: 'visible' | 'hidden' | 'scroll' | 'auto' | (string & {});
    overflowY?: 'visible' | 'hidden' | 'scroll' | 'auto' | (string & {});
    boxShadow?: string;
    textShadow?: string;
    
    // Transform & Animation
    transform?: string;
    transformOrigin?: string;
    transition?: string;
    transitionProperty?: string;
    transitionDuration?: string;
    transitionTimingFunction?: string;
    transitionDelay?: string;
    animation?: string;
    
    // Cursor & Pointer
    cursor?: string;
    pointerEvents?: 'auto' | 'none' | (string & {});
    userSelect?: 'auto' | 'none' | 'text' | 'all' | (string & {});
    
    // Object fit for images/videos
    objectFit?: 'fill' | 'contain' | 'cover' | 'none' | 'scale-down' | (string & {});
    objectPosition?: string;

    // Modern layout
    aspectRatio?: CSSNumericProperty;
    placeItems?: string;
    placeContent?: string;
    placeSelf?: string;
    inset?: CSSNumericProperty;
    insetBlock?: CSSNumericProperty;
    insetInline?: CSSNumericProperty;

    // Containment & Container Queries
    containerType?: 'normal' | 'size' | 'inline-size' | (string & {});
    containerName?: string;
    contain?: string;
    contentVisibility?: 'visible' | 'hidden' | 'auto' | (string & {});

    // Filters & Clipping
    backdropFilter?: string;
    clipPath?: string;
    filter?: string;

    // Masking
    maskImage?: string;
    maskSize?: string;
    maskPosition?: string;
    maskRepeat?: string;

    // Scroll
    overscrollBehavior?: string;
    scrollSnapType?: string;
    scrollSnapAlign?: string;
    scrollBehavior?: 'auto' | 'smooth' | (string & {});
    scrollMargin?: CSSNumericProperty;
    scrollPadding?: CSSNumericProperty;

    // Text
    textDecorationThickness?: CSSNumericProperty;
    textUnderlineOffset?: CSSNumericProperty;

    // Appearance
    accentColor?: string;
    colorScheme?: string;
    
    // Allow any other CSS property
    [key: string]: CSSNumericProperty | undefined;
}

declare global {
    namespace JSX {
        interface IntrinsicAttributes {
            key?: string | number | null;
            id?: string;
            class?: string;
            style?: string | CSSProperties;
            [key: `data-${string}`]: any;
            [key: `aria-${string}`]: any;
        }

        interface IntrinsicElements {
            // HTML
            a: HTMLAttributes<HTMLAnchorElement>;
            abbr: HTMLAttributes<HTMLElement>;
            address: HTMLAttributes<HTMLElement>;
            area: HTMLAttributes<HTMLAreaElement>;
            article: HTMLAttributes<HTMLElement>;
            aside: HTMLAttributes<HTMLElement>;
            audio: HTMLAttributes<HTMLAudioElement>;
            b: HTMLAttributes<HTMLElement>;
            base: HTMLAttributes<HTMLBaseElement>;
            bdi: HTMLAttributes<HTMLElement>;
            bdo: HTMLAttributes<HTMLElement>;
            blockquote: HTMLAttributes<HTMLQuoteElement>;
            body: HTMLAttributes<HTMLBodyElement>;
            br: HTMLAttributes<HTMLBRElement>;
            button: HTMLAttributes<HTMLButtonElement>;
            canvas: HTMLAttributes<HTMLCanvasElement>;
            caption: HTMLAttributes<HTMLTableCaptionElement>;
            cite: HTMLAttributes<HTMLElement>;
            code: HTMLAttributes<HTMLElement>;
            col: HTMLAttributes<HTMLTableColElement>;
            colgroup: HTMLAttributes<HTMLTableColElement>;
            data: HTMLAttributes<HTMLDataElement>;
            datalist: HTMLAttributes<HTMLDataListElement>;
            dd: HTMLAttributes<HTMLElement>;
            del: HTMLAttributes<HTMLModElement>;
            details: HTMLAttributes<HTMLDetailsElement>;
            dfn: HTMLAttributes<HTMLElement>;
            dialog: HTMLAttributes<HTMLDialogElement>;
            div: HTMLAttributes<HTMLDivElement>;
            dl: HTMLAttributes<HTMLDListElement>;
            dt: HTMLAttributes<HTMLElement>;
            em: HTMLAttributes<HTMLElement>;
            embed: HTMLAttributes<HTMLEmbedElement>;
            fieldset: HTMLAttributes<HTMLFieldSetElement>;
            figcaption: HTMLAttributes<HTMLElement>;
            figure: HTMLAttributes<HTMLElement>;
            footer: HTMLAttributes<HTMLElement>;
            form: HTMLAttributes<HTMLFormElement>;
            h1: HTMLAttributes<HTMLHeadingElement>;
            h2: HTMLAttributes<HTMLHeadingElement>;
            h3: HTMLAttributes<HTMLHeadingElement>;
            h4: HTMLAttributes<HTMLHeadingElement>;
            h5: HTMLAttributes<HTMLHeadingElement>;
            h6: HTMLAttributes<HTMLHeadingElement>;
            head: HTMLAttributes<HTMLHeadElement>;
            header: HTMLAttributes<HTMLElement>;
            hgroup: HTMLAttributes<HTMLElement>;
            hr: HTMLAttributes<HTMLHRElement>;
            html: HTMLAttributes<HTMLHtmlElement>;
            i: HTMLAttributes<HTMLElement>;
            iframe: HTMLAttributes<HTMLIFrameElement>;
            img: HTMLAttributes<HTMLImageElement>;
            input: InputHTMLAttributes<HTMLInputElement>;
            ins: HTMLAttributes<HTMLModElement>;
            kbd: HTMLAttributes<HTMLElement>;
            label: HTMLAttributes<HTMLLabelElement>;
            legend: HTMLAttributes<HTMLLegendElement>;
            li: HTMLAttributes<HTMLLIElement>;
            link: HTMLAttributes<HTMLLinkElement>;
            main: HTMLAttributes<HTMLElement>;
            map: HTMLAttributes<HTMLMapElement>;
            mark: HTMLAttributes<HTMLElement>;
            menu: HTMLAttributes<HTMLMenuElement>;
            meta: HTMLAttributes<HTMLMetaElement>;
            meter: HTMLAttributes<HTMLMeterElement>;
            nav: HTMLAttributes<HTMLElement>;
            noscript: HTMLAttributes<HTMLElement>;
            object: HTMLAttributes<HTMLObjectElement>;
            ol: HTMLAttributes<HTMLOListElement>;
            optgroup: HTMLAttributes<HTMLOptGroupElement>;
            option: HTMLAttributes<HTMLOptionElement>;
            output: HTMLAttributes<HTMLOutputElement>;
            p: HTMLAttributes<HTMLParagraphElement>;
            picture: HTMLAttributes<HTMLPictureElement>;
            pre: HTMLAttributes<HTMLPreElement>;
            progress: HTMLAttributes<HTMLProgressElement>;
            q: HTMLAttributes<HTMLQuoteElement>;
            rp: HTMLAttributes<HTMLElement>;
            rt: HTMLAttributes<HTMLElement>;
            ruby: HTMLAttributes<HTMLElement>;
            s: HTMLAttributes<HTMLElement>;
            samp: HTMLAttributes<HTMLElement>;
            script: HTMLAttributes<HTMLScriptElement>;
            search: HTMLAttributes<HTMLElement>;
            section: HTMLAttributes<HTMLElement>;
            select: SelectHTMLAttributes<HTMLSelectElement>;
            slot: HTMLAttributes<HTMLSlotElement>;
            small: HTMLAttributes<HTMLElement>;
            source: HTMLAttributes<HTMLSourceElement>;
            span: HTMLAttributes<HTMLSpanElement>;
            strong: HTMLAttributes<HTMLElement>;
            style: HTMLAttributes<HTMLStyleElement>;
            sub: HTMLAttributes<HTMLElement>;
            summary: HTMLAttributes<HTMLElement>;
            sup: HTMLAttributes<HTMLElement>;
            table: HTMLAttributes<HTMLTableElement>;
            tbody: HTMLAttributes<HTMLTableSectionElement>;
            td: HTMLAttributes<HTMLTableCellElement>;
            template: HTMLAttributes<HTMLTemplateElement>;
            textarea: TextareaHTMLAttributes<HTMLTextAreaElement>;
            tfoot: HTMLAttributes<HTMLTableSectionElement>;
            th: HTMLAttributes<HTMLTableCellElement>;
            thead: HTMLAttributes<HTMLTableSectionElement>;
            time: HTMLAttributes<HTMLTimeElement>;
            title: HTMLAttributes<HTMLTitleElement>;
            tr: HTMLAttributes<HTMLTableRowElement>;
            track: HTMLAttributes<HTMLTrackElement>;
            u: HTMLAttributes<HTMLElement>;
            ul: HTMLAttributes<HTMLUListElement>;
            var: HTMLAttributes<HTMLElement>;
            video: HTMLAttributes<HTMLVideoElement>;
            wbr: HTMLAttributes<HTMLElement>;

            // SVG
            svg: SVGAttributes<SVGSVGElement>;
            circle: SVGAttributes<SVGCircleElement>;
            clipPath: SVGAttributes<SVGClipPathElement>;
            defs: SVGAttributes<SVGDefsElement>;
            ellipse: SVGAttributes<SVGEllipseElement>;
            g: SVGAttributes<SVGGElement>;
            line: SVGAttributes<SVGLineElement>;
            path: SVGAttributes<SVGPathElement>;
            polygon: SVGAttributes<SVGPolygonElement>;
            polyline: SVGAttributes<SVGPolylineElement>;
            rect: SVGAttributes<SVGRectElement>;
            text: SVGAttributes<SVGTextElement>;
            marker: SVGAttributes<SVGMarkerElement>;
            pattern: SVGAttributes<SVGPatternElement>;
            linearGradient: SVGAttributes<SVGLinearGradientElement>;
            radialGradient: SVGAttributes<SVGRadialGradientElement>;
            stop: SVGAttributes<SVGStopElement>;
            image: SVGAttributes<SVGImageElement>;
            use: SVGAttributes<SVGUseElement>;
            mask: SVGAttributes<SVGMaskElement>;
            filter: SVGAttributes<SVGFilterElement>;
            foreignObject: SVGAttributes<SVGForeignObjectElement>;
            tspan: SVGAttributes<SVGTSpanElement>;
            textPath: SVGAttributes<SVGTextPathElement>;
            symbol: SVGAttributes<SVGSymbolElement>;
            // SVG filter primitives
            feBlend: SVGAttributes<SVGFEBlendElement>;
            feColorMatrix: SVGAttributes<SVGFEColorMatrixElement>;
            feComponentTransfer: SVGAttributes<SVGFEComponentTransferElement>;
            feComposite: SVGAttributes<SVGFECompositeElement>;
            feConvolveMatrix: SVGAttributes<SVGFEConvolveMatrixElement>;
            feDiffuseLighting: SVGAttributes<SVGFEDiffuseLightingElement>;
            feDisplacementMap: SVGAttributes<SVGFEDisplacementMapElement>;
            feDistantLight: SVGAttributes<SVGFEDistantLightElement>;
            feDropShadow: SVGAttributes<SVGFEDropShadowElement>;
            feFlood: SVGAttributes<SVGFEFloodElement>;
            feFuncA: SVGAttributes<SVGFEFuncAElement>;
            feFuncB: SVGAttributes<SVGFEFuncBElement>;
            feFuncG: SVGAttributes<SVGFEFuncGElement>;
            feFuncR: SVGAttributes<SVGFEFuncRElement>;
            feGaussianBlur: SVGAttributes<SVGFEGaussianBlurElement>;
            feImage: SVGAttributes<SVGFEImageElement>;
            feMerge: SVGAttributes<SVGFEMergeElement>;
            feMergeNode: SVGAttributes<SVGFEMergeNodeElement>;
            feMorphology: SVGAttributes<SVGFEMorphologyElement>;
            feOffset: SVGAttributes<SVGFEOffsetElement>;
            fePointLight: SVGAttributes<SVGFEPointLightElement>;
            feSpecularLighting: SVGAttributes<SVGFESpecularLightingElement>;
            feSpotLight: SVGAttributes<SVGFESpotLightElement>;
            feTile: SVGAttributes<SVGFETileElement>;
            feTurbulence: SVGAttributes<SVGFETurbulenceElement>;
            // SVG animation
            animate: SVGAttributes<SVGAnimateElement>;
            animateMotion: SVGAttributes<SVGAnimateMotionElement>;
            animateTransform: SVGAttributes<SVGAnimateTransformElement>;
            metadata: SVGAttributes<SVGMetadataElement>;
        }

        /**
         * Extension point for directive `use:*` props with IntelliSense.
         *
         * Directive packages augment this interface to register named `use:*` props,
         * providing autocomplete in JSX. The catch-all `[key: \`use:\${string}\`]`
         * on HTMLAttributes still accepts any custom directive without type errors.
         *
         * @example
         * ```ts
         * declare global {
         *     namespace JSX {
         *         interface DirectiveAttributeExtensions {
         *             'use:myDirective'?: DirectiveDefinition<string> | [DirectiveDefinition<string>, string];
         *         }
         *     }
         * }
         * ```
         */
        interface DirectiveAttributeExtensions {
            // Filled via declaration merging by directive packages
        }

        interface HTMLAttributes<T = HTMLElement> extends IntrinsicAttributes, DirectiveAttributeExtensions {
            // Children
            children?: any;

            // Standard HTML Attributes
            ref?: (el: T) => void;
            accept?: string;
            acceptCharset?: string;
            accessKey?: string;
            action?: string;
            allow?: string;
            allowFullScreen?: boolean;
            allowTransparency?: boolean;
            alt?: string;
            async?: boolean;
            autoComplete?: string;
            autocapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
            autoFocus?: boolean;
            autofocus?: boolean;
            autoPlay?: boolean;
            capture?: boolean | string;
            cellPadding?: number | string;
            cellSpacing?: number | string;
            charSet?: string;
            checked?: boolean;
            cite?: string;
            class?: string;
            className?: string;
            cols?: number;
            colSpan?: number;
            content?: string;
            contentEditable?: boolean | 'true' | 'false' | 'inherit';
            contextMenu?: string;
            controls?: boolean;
            coords?: string;
            crossOrigin?: string;
            data?: string;
            dateTime?: string;
            decoding?: 'sync' | 'async' | 'auto';
            default?: boolean;
            defer?: boolean;
            dir?: 'ltr' | 'rtl' | 'auto';
            dirname?: string;
            disabled?: boolean;
            download?: any;
            draggable?: boolean | 'true' | 'false';
            encType?: string;
            enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
            exportparts?: string;
            for?: string;
            form?: string;
            formAction?: string;
            formEncType?: string;
            formMethod?: string;
            formNoValidate?: boolean;
            formTarget?: string;
            fetchPriority?: 'high' | 'low' | 'auto';
            fetchpriority?: 'high' | 'low' | 'auto';
            frameBorder?: number | string;
            headers?: string;
            height?: number | string;
            hidden?: boolean | 'hidden' | 'until-found' | '';
            high?: number;
            href?: string;
            hrefLang?: string;
            htmlFor?: string;
            httpEquiv?: string;
            id?: string;
            inert?: boolean;
            inputMode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url';
            integrity?: string;
            is?: string;
            keyParams?: string;
            keyType?: string;
            kind?: string;
            label?: string;
            lang?: string;
            list?: string;
            loading?: 'lazy' | 'eager';
            loop?: boolean;
            low?: number;
            manifest?: string;
            marginHeight?: number;
            marginWidth?: number;
            max?: number | string;
            maxLength?: number;
            media?: string;
            mediaGroup?: string;
            method?: string;
            min?: number | string;
            minLength?: number;
            multiple?: boolean;
            muted?: boolean;
            name?: string;
            noValidate?: boolean;
            nonce?: string;
            open?: boolean;
            optimum?: number;
            part?: string;
            pattern?: string;
            placeholder?: string;
            ping?: string;
            playsInline?: boolean;
            popover?: 'auto' | 'manual' | '' | boolean;
            popoverTarget?: string;
            popoverTargetAction?: 'toggle' | 'show' | 'hide';
            poster?: string;
            preload?: string;
            readOnly?: boolean;
            referrerPolicy?: 'no-referrer' | 'no-referrer-when-downgrade' | 'origin' | 'origin-when-cross-origin' | 'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url' | '';
            rel?: string;
            required?: boolean;
            reversed?: boolean;
            role?: string;
            rows?: number;
            rowSpan?: number;
            sandbox?: string;
            scope?: string;
            scoped?: boolean;
            scrolling?: string;
            seamless?: boolean;
            selected?: boolean;
            shape?: string;
            size?: number;
            sizes?: string;
            slot?: string;
            span?: number;
            spellCheck?: boolean | 'true' | 'false';
            src?: string;
            srcDoc?: string;
            srcLang?: string;
            srcSet?: string;
            start?: number;
            step?: number | string;
            style?: string | CSSProperties;
            summary?: string;
            tabIndex?: number;
            target?: string;
            title?: string;
            translate?: 'yes' | 'no' | '';
            type?: string;
            useMap?: string;
            value?: string | string[] | number;
            width?: number | string;
            wmode?: string;
            wrap?: string;

            // Resource hints
            blocking?: 'render' | '';
            elementTiming?: string;

            // Event handlers (React-style camelCase)
            onAbort?: (event: Event) => void;
            onAnimationCancel?: (event: AnimationEvent) => void;
            onAnimationEnd?: (event: AnimationEvent) => void;
            onAnimationIteration?: (event: AnimationEvent) => void;
            onAnimationStart?: (event: AnimationEvent) => void;
            onBeforeInput?: (event: InputEvent) => void;
            onBlur?: (event: FocusEvent) => void;
            onCancel?: (event: Event) => void;
            onCanPlay?: (event: Event) => void;
            onCanPlayThrough?: (event: Event) => void;
            onChange?: (event: Event) => void;
            onClick?: (event: MouseEvent) => void;
            onClose?: (event: Event) => void;
            onCompositionEnd?: (event: CompositionEvent) => void;
            onCompositionStart?: (event: CompositionEvent) => void;
            onCompositionUpdate?: (event: CompositionEvent) => void;
            onContextMenu?: (event: MouseEvent) => void;
            onCopy?: (event: ClipboardEvent) => void;
            onCueChange?: (event: Event) => void;
            onCut?: (event: ClipboardEvent) => void;
            onDblClick?: (event: MouseEvent) => void;
            onDrag?: (event: DragEvent) => void;
            onDragEnd?: (event: DragEvent) => void;
            onDragEnter?: (event: DragEvent) => void;
            onDragExit?: (event: DragEvent) => void;
            onDragLeave?: (event: DragEvent) => void;
            onDragOver?: (event: DragEvent) => void;
            onDragStart?: (event: DragEvent) => void;
            onDrop?: (event: DragEvent) => void;
            onDurationChange?: (event: Event) => void;
            onEmptied?: (event: Event) => void;
            onEnded?: (event: Event) => void;
            onError?: (event: Event) => void;
            onFocus?: (event: FocusEvent) => void;
            onGotPointerCapture?: (event: PointerEvent) => void;
            onInput?: (event: InputEvent) => void;
            onInvalid?: (event: Event) => void;
            onKeyDown?: (event: KeyboardEvent) => void;
            onKeyPress?: (event: KeyboardEvent) => void;
            onKeyUp?: (event: KeyboardEvent) => void;
            onLoad?: (event: Event) => void;
            onLoadedData?: (event: Event) => void;
            onLoadedMetadata?: (event: Event) => void;
            onLoadStart?: (event: Event) => void;
            onLostPointerCapture?: (event: PointerEvent) => void;
            onMouseDown?: (event: MouseEvent) => void;
            onMouseEnter?: (event: MouseEvent) => void;
            onMouseLeave?: (event: MouseEvent) => void;
            onMouseMove?: (event: MouseEvent) => void;
            onMouseOut?: (event: MouseEvent) => void;
            onMouseOver?: (event: MouseEvent) => void;
            onMouseUp?: (event: MouseEvent) => void;
            onMouseWheel?: (event: Event) => void;
            onPaste?: (event: ClipboardEvent) => void;
            onPause?: (event: Event) => void;
            onPlay?: (event: Event) => void;
            onPlaying?: (event: Event) => void;
            onPointerCancel?: (event: PointerEvent) => void;
            onPointerDown?: (event: PointerEvent) => void;
            onPointerEnter?: (event: PointerEvent) => void;
            onPointerLeave?: (event: PointerEvent) => void;
            onPointerMove?: (event: PointerEvent) => void;
            onPointerOut?: (event: PointerEvent) => void;
            onPointerOver?: (event: PointerEvent) => void;
            onPointerUp?: (event: PointerEvent) => void;
            onProgress?: (event: Event) => void;
            onRateChange?: (event: Event) => void;
            onReset?: (event: Event) => void;
            onResize?: (event: UIEvent) => void;
            onScroll?: (event: UIEvent) => void;
            onSeeked?: (event: Event) => void;
            onSeeking?: (event: Event) => void;
            onSelect?: (event: Event) => void;
            onShow?: (event: Event) => void;
            onStalled?: (event: Event) => void;
            onSubmit?: (event: Event) => void;
            onSuspend?: (event: Event) => void;
            onTimeUpdate?: (event: Event) => void;
            onToggle?: (event: Event) => void;
            onTouchCancel?: (event: TouchEvent) => void;
            onTouchEnd?: (event: TouchEvent) => void;
            onTouchMove?: (event: TouchEvent) => void;
            onTouchStart?: (event: TouchEvent) => void;
            onTransitionCancel?: (event: TransitionEvent) => void;
            onTransitionEnd?: (event: TransitionEvent) => void;
            onTransitionRun?: (event: TransitionEvent) => void;
            onTransitionStart?: (event: TransitionEvent) => void;
            onVolumeChange?: (event: Event) => void;
            onWaiting?: (event: Event) => void;
            onWheel?: (event: WheelEvent) => void;

            // Also support lowercase for compatibility
            onabort?: (event: Event) => void;
            onanimationcancel?: (event: AnimationEvent) => void;
            onanimationend?: (event: AnimationEvent) => void;
            onanimationiteration?: (event: AnimationEvent) => void;
            onanimationstart?: (event: AnimationEvent) => void;
            onbeforeinput?: (event: InputEvent) => void;
            onblur?: (event: FocusEvent) => void;
            oncancel?: (event: Event) => void;
            oncanplay?: (event: Event) => void;
            oncanplaythrough?: (event: Event) => void;
            onchange?: (event: Event) => void;
            onclick?: (event: MouseEvent) => void;
            onclose?: (event: Event) => void;
            oncompositionend?: (event: CompositionEvent) => void;
            oncompositionstart?: (event: CompositionEvent) => void;
            oncompositionupdate?: (event: CompositionEvent) => void;
            oncontextmenu?: (event: MouseEvent) => void;
            oncopy?: (event: ClipboardEvent) => void;
            oncuechange?: (event: Event) => void;
            oncut?: (event: ClipboardEvent) => void;
            ondblclick?: (event: MouseEvent) => void;
            ondrag?: (event: DragEvent) => void;
            ondragend?: (event: DragEvent) => void;
            ondragenter?: (event: DragEvent) => void;
            ondragexit?: (event: DragEvent) => void;
            ondragleave?: (event: DragEvent) => void;
            ondragover?: (event: DragEvent) => void;
            ondragstart?: (event: DragEvent) => void;
            ondrop?: (event: DragEvent) => void;
            ondurationchange?: (event: Event) => void;
            onemptied?: (event: Event) => void;
            onended?: (event: Event) => void;
            onerror?: (event: Event | string) => void;
            onfocus?: (event: FocusEvent) => void;
            ongotpointercapture?: (event: PointerEvent) => void;
            oninput?: (event: InputEvent) => void;
            oninvalid?: (event: Event) => void;
            onkeydown?: (event: KeyboardEvent) => void;
            onkeypress?: (event: KeyboardEvent) => void;
            onkeyup?: (event: KeyboardEvent) => void;
            onload?: (event: Event) => void;
            onloadeddata?: (event: Event) => void;
            onloadedmetadata?: (event: Event) => void;
            onloadstart?: (event: Event) => void;
            onlostpointercapture?: (event: PointerEvent) => void;
            onmousedown?: (event: MouseEvent) => void;
            onmouseenter?: (event: MouseEvent) => void;
            onmouseleave?: (event: MouseEvent) => void;
            onmousemove?: (event: MouseEvent) => void;
            onmouseout?: (event: MouseEvent) => void;
            onmouseover?: (event: MouseEvent) => void;
            onmouseup?: (event: MouseEvent) => void;
            onmousewheel?: (event: Event) => void;
            onpaste?: (event: ClipboardEvent) => void;
            onpause?: (event: Event) => void;
            onplay?: (event: Event) => void;
            onplaying?: (event: Event) => void;
            onpointercancel?: (event: PointerEvent) => void;
            onpointerdown?: (event: PointerEvent) => void;
            onpointerenter?: (event: PointerEvent) => void;
            onpointerleave?: (event: PointerEvent) => void;
            onpointermove?: (event: PointerEvent) => void;
            onpointerout?: (event: PointerEvent) => void;
            onpointerover?: (event: PointerEvent) => void;
            onpointerup?: (event: PointerEvent) => void;
            onprogress?: (event: Event) => void;
            onratechange?: (event: Event) => void;
            onreset?: (event: Event) => void;
            onresize?: (event: UIEvent) => void;
            onscroll?: (event: UIEvent) => void;
            onseeked?: (event: Event) => void;
            onseeking?: (event: Event) => void;
            onselect?: (event: Event) => void;
            onshow?: (event: Event) => void;
            onstalled?: (event: Event) => void;
            onsubmit?: (event: Event) => void;
            onsuspend?: (event: Event) => void;
            ontimeupdate?: (event: Event) => void;
            ontoggle?: (event: Event) => void;
            ontouchcancel?: (event: TouchEvent) => void;
            ontouchend?: (event: TouchEvent) => void;
            ontouchmove?: (event: TouchEvent) => void;
            ontouchstart?: (event: TouchEvent) => void;
            ontransitioncancel?: (event: TransitionEvent) => void;
            ontransitionend?: (event: TransitionEvent) => void;
            ontransitionrun?: (event: TransitionEvent) => void;
            ontransitionstart?: (event: TransitionEvent) => void;
            onvolumechange?: (event: Event) => void;
            onwaiting?: (event: Event) => void;
            onwheel?: (event: WheelEvent) => void;

            // Allow any event handler
            [key: `on${string}`]: any;

            // ARIA
            [key: `aria-${string}`]: any;
            [key: `data-${string}`]: any;

            // Directives (use:name syntax) — catch-all for custom directives
            // Named built-in directives get IntelliSense via DirectiveAttributeExtensions
            [key: `use:${string}`]: import('@sigx/runtime-core').DirectiveDefinition | [import('@sigx/runtime-core').DirectiveDefinition, any] | any;

            /**
             * DOM property access — bypasses setAttribute, sets the property directly on the element.
             *
             * Prefix any DOM property name with `prop:` to force a direct property assignment:
             *   `prop:innerHTML`, `prop:textContent`, `prop:innerText`, `prop:value`, etc.
             *
             * The `prop:` prefix is stripped at runtime — `<div prop:innerHTML={html} />`
             * becomes `element.innerHTML = html`.
             *
             * @example
             * ```tsx
             * <div prop:innerHTML={renderMarkdownToHtml(content)} />
             * <input prop:value={rawValue} />
             * ```
             */
            [key: `prop:${string}`]: any;
        }

        interface FormElementAttributes<T = HTMLElement, V = any> extends HTMLAttributes<T> {
            // Model directive (two-way binding)
            model?: [object, string] | (() => V) | Model<any>;
            [key: `model:${string}`]: [object, string] | (() => any);

            // Explicit update event support
            "onUpdate:modelValue"?: (value: V) => void;
        }

        interface NumberInputAttributes<T = HTMLInputElement> extends FormElementAttributes<T, number> {
            type: "number";
            value?: number | string;
        }

        interface RangeInputAttributes<T = HTMLInputElement> extends FormElementAttributes<T, number> {
            type: "range";
            value?: number | string;
            min?: number | string;
            max?: number | string;
            step?: number | string;
        }

        interface CheckboxInputAttributes<T = HTMLInputElement> extends HTMLAttributes<T> {
            type: "checkbox" | "radio";
            checked?: boolean;
            // Model allows boolean (checked state), arrays (multi-checkbox), or primitives (radio values)
            model?: [object, string] | (() => boolean | any[] | string | number) | Model<any>;
            // The update event for checkbox/radio is always the checked state (boolean)
            "onUpdate:modelValue"?: (checked: boolean) => void;
            [key: `model:${string}`]: [object, string] | (() => any);
        }

        interface TextInputAttributes<T = HTMLInputElement> extends FormElementAttributes<T, string> {
            type?: "text" | "password" | "email" | "search" | "tel" | "url" | "date" | "datetime-local" | "month" | "time" | "week" | "color" | "file" | "hidden" | "image" | "reset" | "submit" | "button";
            value?: string;
        }

        type InputHTMLAttributes<T = HTMLInputElement> = NumberInputAttributes<T> | RangeInputAttributes<T> | CheckboxInputAttributes<T> | TextInputAttributes<T>;

        interface TextareaHTMLAttributes<T = HTMLTextAreaElement> extends FormElementAttributes<T, string> {
            value?: string;
        }

        interface SingleSelectAttributes<T = HTMLSelectElement> extends FormElementAttributes<T, string> {
            multiple?: false;
            value?: string;
        }

        interface MultiSelectAttributes<T = HTMLSelectElement> extends FormElementAttributes<T, string[]> {
            multiple: true;
            value?: string[];
        }

        type SelectHTMLAttributes<T = HTMLSelectElement> = SingleSelectAttributes<T> | MultiSelectAttributes<T>;

        interface SVGAttributes<T = SVGElement> extends HTMLAttributes<T> {
            // SVG-specific attributes
            accentHeight?: number | string;
            accumulate?: 'none' | 'sum';
            additive?: 'replace' | 'sum';
            alignmentBaseline?: string;
            allowReorder?: 'no' | 'yes';
            alphabetic?: number | string;
            amplitude?: number | string;
            arabicForm?: 'initial' | 'medial' | 'terminal' | 'isolated';
            ascent?: number | string;
            attributeName?: string;
            attributeType?: string;
            autoReverse?: boolean | string;
            azimuth?: number | string;
            baseFrequency?: number | string;
            baselineShift?: number | string;
            baseProfile?: string;
            bbox?: number | string;
            begin?: number | string;
            bias?: number | string;
            by?: number | string;
            calcMode?: number | string;
            capHeight?: number | string;
            clip?: number | string;
            clipPath?: string;
            clipPathUnits?: number | string;
            clipRule?: number | string;
            colorInterpolation?: number | string;
            colorInterpolationFilters?: 'auto' | 'sRGB' | 'linearRGB' | 'inherit';
            colorProfile?: number | string;
            colorRendering?: number | string;
            contentScriptType?: number | string;
            contentStyleType?: number | string;
            cursor?: number | string;
            cx?: number | string;
            cy?: number | string;
            d?: string;
            decelerate?: number | string;
            descent?: number | string;
            diffuseConstant?: number | string;
            direction?: number | string;
            display?: number | string;
            divisor?: number | string;
            dominantBaseline?: number | string;
            dur?: number | string;
            dx?: number | string;
            dy?: number | string;
            edgeMode?: number | string;
            elevation?: number | string;
            enableBackground?: number | string;
            end?: number | string;
            exponent?: number | string;
            externalResourcesRequired?: boolean | string;
            fill?: string;
            fillOpacity?: number | string;
            fillRule?: 'nonzero' | 'evenodd' | 'inherit';
            filter?: string;
            filterRes?: number | string;
            filterUnits?: number | string;
            floodColor?: number | string;
            floodOpacity?: number | string;
            focusable?: boolean | string;
            fontFamily?: string;
            fontSize?: number | string;
            fontSizeAdjust?: number | string;
            fontStretch?: number | string;
            fontStyle?: number | string;
            fontVariant?: number | string;
            fontWeight?: number | string;
            format?: number | string;
            from?: number | string;
            fx?: number | string;
            fy?: number | string;
            g1?: number | string;
            g2?: number | string;
            glyphName?: number | string;
            glyphOrientationHorizontal?: number | string;
            glyphOrientationVertical?: number | string;
            glyphRef?: number | string;
            gradientTransform?: string;
            gradientUnits?: string;
            hanging?: number | string;
            horizAdvX?: number | string;
            horizOriginX?: number | string;
            ideographic?: number | string;
            imageRendering?: number | string;
            in2?: number | string;
            in?: string;
            intercept?: number | string;
            k1?: number | string;
            k2?: number | string;
            k3?: number | string;
            k4?: number | string;
            k?: number | string;
            kernelMatrix?: number | string;
            kernelUnitLength?: number | string;
            kerning?: number | string;
            keyPoints?: number | string;
            keySplines?: number | string;
            keyTimes?: number | string;
            lengthAdjust?: number | string;
            letterSpacing?: number | string;
            lightingColor?: number | string;
            limitingConeAngle?: number | string;
            local?: number | string;
            markerEnd?: string;
            markerHeight?: number | string;
            markerMid?: string;
            markerStart?: string;
            markerUnits?: number | string;
            markerWidth?: number | string;
            mask?: string;
            maskContentUnits?: number | string;
            maskUnits?: number | string;
            mathematical?: number | string;
            mode?: number | string;
            numOctaves?: number | string;
            offset?: number | string;
            opacity?: number | string;
            operator?: number | string;
            order?: number | string;
            orient?: number | string;
            orientation?: number | string;
            origin?: number | string;
            overflow?: number | string;
            overlinePosition?: number | string;
            overlineThickness?: number | string;
            paintOrder?: number | string;
            panose1?: number | string;
            pathLength?: number | string;
            patternContentUnits?: string;
            patternTransform?: number | string;
            patternUnits?: string;
            pointerEvents?: number | string;
            points?: string;
            pointsAtX?: number | string;
            pointsAtY?: number | string;
            pointsAtZ?: number | string;
            preserveAlpha?: boolean | string;
            preserveAspectRatio?: string;
            primitiveUnits?: number | string;
            r?: number | string;
            radius?: number | string;
            refX?: number | string;
            refY?: number | string;
            renderingIntent?: number | string;
            repeatCount?: number | string;
            repeatDur?: number | string;
            requiredExtensions?: number | string;
            requiredFeatures?: number | string;
            restart?: number | string;
            result?: string;
            rotate?: number | string;
            rx?: number | string;
            ry?: number | string;
            scale?: number | string;
            seed?: number | string;
            shapeRendering?: number | string;
            slope?: number | string;
            spacing?: number | string;
            specularConstant?: number | string;
            specularExponent?: number | string;
            speed?: number | string;
            spreadMethod?: string;
            startOffset?: number | string;
            stdDeviation?: number | string;
            stemh?: number | string;
            stemv?: number | string;
            stitchTiles?: number | string;
            stopColor?: string;
            stopOpacity?: number | string;
            strikethroughPosition?: number | string;
            strikethroughThickness?: number | string;
            string?: number | string;
            stroke?: string;
            strokeDasharray?: string | number;
            strokeDashoffset?: string | number;
            strokeLinecap?: 'butt' | 'round' | 'square' | 'inherit';
            strokeLinejoin?: 'miter' | 'round' | 'bevel' | 'inherit';
            strokeMiterlimit?: number | string;
            strokeOpacity?: number | string;
            strokeWidth?: number | string;
            surfaceScale?: number | string;
            systemLanguage?: number | string;
            tableValues?: number | string;
            targetX?: number | string;
            targetY?: number | string;
            textAnchor?: string;
            textDecoration?: number | string;
            textLength?: number | string;
            textRendering?: number | string;
            to?: number | string;
            transform?: string;
            u1?: number | string;
            u2?: number | string;
            underlinePosition?: number | string;
            underlineThickness?: number | string;
            unicode?: number | string;
            unicodeBidi?: number | string;
            unicodeRange?: number | string;
            unitsPerEm?: number | string;
            vAlphabetic?: number | string;
            vectorEffect?: number | string;
            version?: string;
            vertAdvY?: number | string;
            vertOriginX?: number | string;
            vertOriginY?: number | string;
            vHanging?: number | string;
            vIdeographic?: number | string;
            viewBox?: string;
            viewTarget?: number | string;
            visibility?: number | string;
            vMathematical?: number | string;
            widths?: number | string;
            wordSpacing?: number | string;
            writingMode?: number | string;
            x1?: number | string;
            x2?: number | string;
            x?: number | string;
            xChannelSelector?: string;
            xHeight?: number | string;
            xlinkActuate?: string;
            xlinkArcrole?: string;
            xlinkHref?: string;
            xlinkRole?: string;
            xlinkShow?: string;
            xlinkTitle?: string;
            xlinkType?: string;
            xmlBase?: string;
            xmlLang?: string;
            xmlns?: string;
            xmlnsXlink?: string;
            xmlSpace?: string;
            y1?: number | string;
            y2?: number | string;
            y?: number | string;
            yChannelSelector?: string;
            z?: number | string;
            zoomAndPan?: string;
        }
    }
}

export { };
