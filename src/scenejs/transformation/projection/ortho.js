/**
 * Scene node that constructs an ortographic projection matrix and sets it on the current shader.
 */
(function() {

    function makeOrtho(left, right,
                       bottom, top,
                       znear, zfar) {
        var tx = -(right + left) / (right - left);
        var ty = -(top + bottom) / (top - bottom);
        var tz = -(zfar + znear) / (zfar - znear);

        return $M([
            [2 / (right - left), 0, 0, tx],
            [0, 2 / (top - bottom), 0, ty],
            [0, 0, -2 / (zfar - znear), tz],
            [0, 0, 0, 1]
        ]);
    }

    SceneJs.ortho = function() {
        var cfg = SceneJs.utils.getNodeConfig(arguments);
        var backend = SceneJs.backends.getBackend('projection-transform');
        var xform;
        return function(scope) {
            if (!xform || !cfg.fixed) {
                var params = cfg.getParams(scope);
                var tempMat = makeOrtho(
                        params.left || -1.0,
                        params.right || 1.0,
                        params.bottom || -1.0,
                        params.top || 1.0,
                        params.near || 0.1,
                        params.far || 100.0
                        );
                xform = {
                    matrix: tempMat,
                    matrixAsArray: new WebGLFloatArray(tempMat.flatten())
                };
            }
            var prevXform = backend.getTransform();
            backend.setTransform(xform);
            SceneJs.utils.visitChildren(cfg, scope);
            backend.setTransform(prevXform);
        };
    };
})();