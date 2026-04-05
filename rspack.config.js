const path = require('path');

module.exports = {
    entry: './src/index.ts',
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: 'builtin:swc-loader', // Faster than ts-loader
                options: {
                    jsc: {
                        parser: {
                            syntax: 'typescript',
                        },
                    },
                },
                type: 'javascript/auto',
            },
        ],
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        library: {
            type: 'umd',
            name: 'MyFingerprintLib',
        },
        globalObject: 'self', // Better for browser/worker compatibility
        clean: true,
    },
    externals: {
        '@fingerprintjs/fingerprintjs': '@fingerprintjs/fingerprintjs'
    },
};
