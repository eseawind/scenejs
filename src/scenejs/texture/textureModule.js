/**
 * Backend that manages material texture layers.
 *
 * Manages asynchronous load of texture images.
 *
 * Caches textures with a least-recently-used eviction policy.
 *
 * Holds currently-applied textures as "layers". Each layer specifies a texture and a set of parameters for
 * how the texture is to be applied, ie. to modulate ambient, diffuse, specular material colors, geometry normals etc.
 *
 * Holds the layers on a stack and provides the SceneJS.texture node with methods to push and pop them.
 *
 * Interacts with the shading backend through events; on a SHADER_RENDERING event it will respond with a
 * TEXTURES_EXPORTED to pass the entire layer stack to the shading backend.
 *
 * Avoids redundant export of the layers with a dirty flag; they are only exported when that is set, which occurs
 * when the stack is pushed or popped by the texture node, or on SCENE_COMPILING, SHADER_ACTIVATED and
 * SHADER_DEACTIVATED events.
 *
 * Whenever a texture node pushes or pops the stack, this backend publishes it with a TEXTURES_UPDATED to allow other
 * dependent backends to synchronise their resources.
 *
 *  @private
 */
var SceneJS_textureModule = new (function() {

    var time = (new Date()).getTime();      // Current system time for LRU caching
    var canvas;
    var textures = {};

    var idStack = new Array(255);
    var textureStack = new Array(255);
    var stackLen = 0;

    var dirty;

    SceneJS_eventModule.addListener(
            SceneJS_eventModule.TIME_UPDATED,
            function(t) {
                time = t;
            });

    SceneJS_eventModule.addListener(
            SceneJS_eventModule.SCENE_COMPILING,
            function() {
                stackLen = 0;
                dirty = true;
            });

    SceneJS_eventModule.addListener(
            SceneJS_eventModule.CANVAS_ACTIVATED,
            function(c) {
                canvas = c;
                dirty = true;
            });

    SceneJS_eventModule.addListener(
            SceneJS_eventModule.CANVAS_DEACTIVATED,
            function() {
                canvas = null;
                dirty = true;
            });

    SceneJS_eventModule.addListener(
            SceneJS_eventModule.SHADER_ACTIVATED,
            function() {
                dirty = true;
            });

    SceneJS_eventModule.addListener(
            SceneJS_eventModule.SHADER_RENDERING,
            function() {
                if (dirty) {
                    if (stackLen > 0) {
                        SceneJS_renderModule.setTexture(idStack[stackLen - 1], textureStack[stackLen - 1]);
                    } else {
                        SceneJS_renderModule.setTexture();
                    }
                    dirty = false;
                }
            });

    SceneJS_eventModule.addListener(
            SceneJS_eventModule.SHADER_DEACTIVATED,
            function() {
                dirty = true;
            });

    /** Removes texture from shader (if canvas exists in DOM) and deregisters it from backend
     * @private
     */
    function deleteTexture(texture) {
        textures[texture.textureId] = undefined;
        if (document.getElementById(texture.canvas.canvasId)) {
            texture.destroy();
        }
    }

    /**
     * Deletes all textures from their GL contexts - does not attempt
     * to delete them when their canvases no longer exist in the DOM.
     * @private
     */
    function deleteTextures() {
        for (var textureId in textures) {
            var texture = textures[textureId];
            deleteTexture(texture);
        }
        textures = {};
        stackLen = 0;
        dirty = true;
    }

    SceneJS_eventModule.addListener(
            SceneJS_eventModule.RESET, // Framework reset - delete textures
            function() {
                deleteTextures();
            });

    /**
     * Translates a SceneJS param value to a WebGL enum value,
     * or to default if undefined. Throws exception when defined
     * but not mapped to an enum.
     * @private
     */
    function getGLOption(name, context, cfg, defaultVal) {
        var value = cfg[name];
        if (value == undefined) {
            return defaultVal;
        }
        var glName = SceneJS_webgl_enumMap[value];
        if (glName == undefined) {
            throw SceneJS._errorModule.fatalError(
                    SceneJS.errors.ILLEGAL_NODE_CONFIG,
                    "Unrecognised value for SceneJS.texture node property '" + name + "' value: '" + value + "'");
        }
        var glValue = context[glName];
        //                if (!glValue) {
        //                    throw new SceneJS.errors.WebGLUnsupportedNodeConfigException(
        //                            "This browser's WebGL does not support value of SceneJS.texture node property '" + name + "' value: '" + value + "'");
        //                }
        return glValue;
    }

    /** Returns default value for when given value is undefined
     * @private
     */
    function getOption(value, defaultVal) {
        return (value == undefined) ? defaultVal : value;
    }

    this.textureExists = function(texture) {
        return textures[texture.textureId];
    };

    /** Asynchronously creates a texture, either from image URL or image object
     */
    this.createTexture = function(cfg, onSuccess, onError, onAbort) {

        var _canvas = canvas;
        var _context = canvas.context;
        if (cfg.uri) {

            var image = new Image();

            /* Start a SceneJS process for the texture load and creation
             */
            var process = SceneJS_processModule.createProcess({
                description:"creating texture: uri = " + cfg.uri,
                type: "create-texture",
                info: {
                    uri: cfg.uri
                },
                timeoutSecs: -1 // Relying on Image object for timeout
            });

            /* Kill process on successful load and creation
             */
            image.onload = function() {
                var textureId = allocateTexture(_canvas, _context, image, cfg);
                SceneJS_processModule.killProcess(process);
                onSuccess(textures[textureId]);
            };

            /* Kill process on error
             */
            image.onerror = function() {
                SceneJS_processModule.killProcess(process);
                onError();
            };

            /* Kill process on abort
             */
            image.onabort = function() {
                SceneJS_processModule.killProcess(process);
                onAbort();
            };
            image.src = cfg.uri;  // Starts image load

        } else

        /*--------------------------------------------------------------------
         * Image texture
         *-------------------------------------------------------------------*/

            if (cfg.image) {
                var textureId = allocateTexture(_canvas, _context, cfg.image, cfg);
                onSuccess(textures[textureId]);

            } else

            /*--------------------------------------------------------------------
             * Canvas texture
             *-------------------------------------------------------------------*/

                if (cfg.canvasId) {

                    var srcCanvas = document.getElementById(cfg.canvasId);
                    if (!srcCanvas) {
                        throw SceneJS._errorModule.fatalError(
                                SceneJS.errors.ILLEGAL_NODE_CONFIG,
                                "Could not find canvas for texture node '" + cfg.canvasId + "'");
                    }
                    var textureId = allocateTexture(_canvas, _context, srcCanvas, cfg);
                    onSuccess(textures[textureId]);
                } else {
                    throw "Failed to create texture: neither cfg.image nor cfg.uri supplied";
                }
    };

    function allocateTexture(canvas, context, image, cfg) {
        var textureId = SceneJS._createUUID();
        try {
            if (cfg.autoUpdate) {
                var update = function() {
                    //TODO: fix this when minefield is upto spec
                    try {
                        context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, image);
                    }
                    catch(e) {
                        context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, image, null);
                    }
                    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
                    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
                    //  context.generateMipmap(context.TEXTURE_2D);
                };
            }
            textures[textureId] = new SceneJS_webgl_Texture2D(context, {
                textureId : textureId,
                canvas: canvas,
                image : ensureImageSizePowerOfTwo(image),
                texels :cfg.texels,
                minFilter : getGLOption("minFilter", context, cfg, context.LINEAR),
                magFilter :  getGLOption("magFilter", context, cfg, context.LINEAR),
                wrapS : getGLOption("wrapS", context, cfg, context.CLAMP_TO_EDGE),
                wrapT :   getGLOption("wrapT", context, cfg, context.CLAMP_TO_EDGE),
                isDepth :  getOption(cfg.isDepth, false),
                depthMode : getGLOption("depthMode", context, cfg, context.LUMINANCE),
                depthCompareMode : getGLOption("depthCompareMode", context, cfg, context.COMPARE_R_TO_TEXTURE),
                depthCompareFunc : getGLOption("depthCompareFunc", context, cfg, context.LEQUAL),
                flipY : getOption(cfg.flipY, true),
                width: getOption(cfg.width, 1),
                height: getOption(cfg.height, 1),
                internalFormat : getGLOption("internalFormat", context, cfg, context.LEQUAL),
                sourceFormat : getGLOption("sourceType", context, cfg, context.ALPHA),
                sourceType : getGLOption("sourceType", context, cfg, context.UNSIGNED_BYTE),
                logging: SceneJS_loggingModule ,
                update: update
            });
        } catch (e) {
            throw SceneJS._errorModule.fatalError(SceneJS.errors.ERROR, "Failed to create texture: " + e.message || e);
        }
        return textureId;
    }

    function ensureImageSizePowerOfTwo(image) {
        if (!isPowerOfTwo(image.width) || !isPowerOfTwo(image.height)) {
            var canvas = document.createElement("canvas");
            canvas.width = nextHighestPowerOfTwo(image.width);
            canvas.height = nextHighestPowerOfTwo(image.height);
            var ctx = canvas.getContext("2d");
            ctx.drawImage(image,
                    0, 0, image.width, image.height,
                    0, 0, canvas.width, canvas.height);
            image = canvas;
        }
        return image;
    }

    function isPowerOfTwo(x) {
        return (x & (x - 1)) == 0;
    }

    function nextHighestPowerOfTwo(x) {
        --x;
        for (var i = 1; i < 32; i <<= 1) {
            x = x | x >> i;
        }
        return x + 1;
    }

    this.destroyTexture = function(texture) {
        texture.destroy(); // Idempotent
        delete textures[texture.textureId];
    };

    this.pushTexture = function(id, layers) {
        idStack[stackLen] = id;
        textureStack[stackLen] = layers;
        stackLen++;
        dirty = true;
    };

    this.popTexture = function() {
        stackLen--;
        dirty = true;
    };
})();