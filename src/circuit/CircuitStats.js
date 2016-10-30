import {CircuitDefinition} from "src/circuit/CircuitDefinition.js"
import {CircuitEvalContext} from "src/circuit/CircuitEvalContext.js"
import {CircuitShaders} from "src/circuit/CircuitShaders.js"
import {KetTextureUtil} from "src/circuit/KetTextureUtil.js"
import {Config} from "src/Config.js"
import {Controls} from "src/circuit/Controls.js"
import {DetailedError} from "src/base/DetailedError.js"
import {Format} from "src/base/Format.js"
import {Gate} from "src/circuit/Gate.js"
import {Gates} from "src/gates/AllGates.js"
import {Matrix} from "src/math/Matrix.js"
import {Point} from "src/math/Point.js"
import {Shaders} from "src/webgl/Shaders.js"
import {Serializer} from "src/circuit/Serializer.js"
import {Util} from "src/base/Util.js"
import {seq, Seq} from "src/base/Seq.js"
import {notifyAboutRecoveryFromUnexpectedError} from "src/fallback.js"
import {advanceStateWithCircuit} from "src/circuit/CircuitComputeUtil.js"
import {currentShaderCoder} from "src/webgl/ShaderCoders.js"
import {WglTexturePool} from "src/webgl/WglTexturePool.js"
import {WglTextureTrader} from "src/webgl/WglTextureTrader.js"

class CircuitStats {
    /**
     * @param {!CircuitDefinition} circuitDefinition
     * @param {!number} time
     * @param {!Array.<!number>} survivalRates
     * @param {!Array.<!Array.<!Matrix>>} singleQubitDensities
     * @param {!Matrix} finalState
     * @param {!Map<!string, *>} customStatsProcessed
     */
    constructor(circuitDefinition,
                time,
                survivalRates,
                singleQubitDensities,
                finalState,
                customStatsProcessed) {
        /**
         * The circuit that these stats apply to.
         * @type {!CircuitDefinition}
         */
        this.circuitDefinition = circuitDefinition;
        /**
         * The time these stats apply to.
         * @type {!number}
         */
        this.time = time;
        /**
         * @type {!Array.<!number>}
         * @private
         */
        this._survivalRates = survivalRates;
        /**
         * The density matrix of individual qubits.
         * (This case is special-cased, instead of using customStats like the other density displays, because
         *  single-qubit displays are so much more common. Also they appear in bulk at the end of the circuit.)
         * @type {!Array.<!Array.<!Matrix>>}
         * @private
         */
        this._qubitDensities = singleQubitDensities;
        /**
         * The output quantum superposition, as a column vector.
         * @type {!Matrix}
         */
        this.finalState = finalState;
        /**
         * @type {!Map.<!string, *>}
         * @private
         */
        this._customStatsProcessed = customStatsProcessed;
    }

    /**
     * Returns the density matrix of a qubit at a particular point in the circuit.
     *
     * Note: only available if there was a corresponding display gate at that position. Otherwise result is NaN.
     *
     * @param {!int} colIndex
     * @param {!int} wireIndex
     * @returns {!Matrix}
     */
    qubitDensityMatrix(colIndex, wireIndex) {
        if (wireIndex < 0) {
            throw new DetailedError("Bad wireIndex", {wireIndex, colIndex});
        }

        // The initial state is all-qubits-off.
        if (colIndex < 0 || wireIndex >= this.circuitDefinition.numWires) {
            if (wireIndex >= this.circuitDefinition.numWires && this.qubitDensityMatrix(colIndex, 0).hasNaN()) {
                return Matrix.zero(2, 2).times(NaN);
            }
            let buf = new Float32Array(8);
            buf[0] = 1;
            return new Matrix(2, 2, buf);
        }

        let col = Math.min(colIndex, this._qubitDensities.length - 1);
        if (col < 0 || wireIndex >= this._qubitDensities[col].length) {
            return Matrix.zero(2, 2).times(NaN);
        }
        return this._qubitDensities[col][wireIndex];
    }

    /**
     * Determines how often the circuit evaluation survives to the given column, without being post-selected out.
     *
     * Note that over-unitary gates will increase this number, so perhaps 'survival rate' isn't quite the best name.
     *
     * @param {!int} colIndex
     * @returns {!number}
     */
    survivalRate(colIndex) {
        colIndex = Math.min(colIndex, this._survivalRates.length - 1);
        return colIndex < 0 ? 1 : this._survivalRates[colIndex];
    }

    /**
     * @param {!int} col
     * @param {!int} row
     * @returns {undefined|*}
     */
    customStatsForSlot(col, row) {
        let key = col+":"+row;
        return this._customStatsProcessed.has(key) ? this._customStatsProcessed.get(key) : undefined;
    }

    /**
     * Returns the probability that a wire would be on if it was measured just before a given column, but conditioned on
     * wires with controls in that column matching their controls.
     * A wire is never conditioned on itself; self-conditions are ignored when computing the probability.
     *
     * @param {int} wireIndex
     * @param {int|Infinity} colIndex
     * @returns {!number}
     */
    controlledWireProbabilityJustAfter(wireIndex, colIndex) {
        return this.qubitDensityMatrix(colIndex, wireIndex).rawBuffer()[6];
    }

    /**
     * @param {!number} time
     * @returns {!CircuitStats}
     */
    withTime(time) {
        return new CircuitStats(
            this.circuitDefinition,
            time,
            this._survivalRates,
            this._qubitDensities,
            this.finalState,
            this._customStatsProcessed);
    }

    /**
     * @param {!CircuitDefinition} circuitDefinition
     * @param {!number} time
     * @returns {!CircuitStats}
     */
    static withNanDataFromCircuitAtTime(circuitDefinition, time) {
        return new CircuitStats(
            circuitDefinition,
            time,
            [0],
            [],
            Matrix.zero(1, 1 << circuitDefinition.numWires).times(NaN),
            new Map());
    }

    /**
     * @param {!CircuitDefinition} circuitDefinition
     * @param {!number} time
     * @returns {!CircuitStats}
     */
    static fromCircuitAtTime(circuitDefinition, time) {
        try {
            return CircuitStats._fromCircuitAtTime_noFallback(circuitDefinition, time);
        } catch (ex) {
            notifyAboutRecoveryFromUnexpectedError(
                `Defaulted to NaN results. Computing circuit values failed.`,
                {circuitDefinition: Serializer.toJson(circuitDefinition)},
                ex);
            return CircuitStats.withNanDataFromCircuitAtTime(circuitDefinition, time);
        }
    }

    /**
     * Returns the same density matrix, but without any diagonal terms related to qubits that have been measured.
     * @param {!Matrix} densityMatrix
     * @param {!int} isMeasuredMask A bitmask where each 1 corresponds to a measured qubit position.
     * @returns {!Matrix}
     */
    static decohereMeasuredBitsInDensityMatrix(densityMatrix, isMeasuredMask) {
        if (isMeasuredMask === 0) {
            return densityMatrix;
        }

        let buf = new Float32Array(densityMatrix.rawBuffer());
        let n = densityMatrix.width();
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < n; col++) {
                if (((row ^ col) & isMeasuredMask) !== 0) {
                    let k = (row*n + col)*2;
                    buf[k] = 0;
                    buf[k+1] = 0;
                }
            }
        }
        return new Matrix(n, n, buf);
    }

    /**
     * @param {!Array.<!Matrix>} rawMatrices
     * @param {!int} numWires
     * @param {!int} qubitSpan
     * @param {!int} isMeasuredMask
     * @param {!int} hasDisplayMask
     * @returns {!Array.<!Matrix>}
     */
    static scatterAndDecohereDensities(rawMatrices, numWires, qubitSpan, isMeasuredMask, hasDisplayMask) {
        let nanMatrix = Matrix.zero(1 << qubitSpan, 1 << qubitSpan).times(NaN);
        let used = 0;
        let result = [];
        for (let row = 0; row < numWires - qubitSpan + 1; row++) {
            if ((hasDisplayMask & (1 << row)) === 0) {
                result.push(nanMatrix);
            } else {
                result.push(CircuitStats.decohereMeasuredBitsInDensityMatrix(
                    rawMatrices[used++],
                    (isMeasuredMask >> row) & ((1 << qubitSpan) - 1)));
            }
        }
        return result;
    }

    /**
     * @param {!CircuitDefinition} circuitDefinition
     * @param {!Array.<!Float32Array>} colQubitDensitiesPixelData
     * @returns {!{survivalRates: !Array.<!number>, qubitDensities: !Array.<!Array<!Matrix>>}}
     * @private
     */
    static _extractCommonColumnStatsFromColPixelDatas(circuitDefinition, colQubitDensitiesPixelData) {
        let survivalRate = 1;
        let survivalRates = [];
        let qubitDensities = [];
        for (let col = 0; col < colQubitDensitiesPixelData.length; col++) {
            let qubitDensityPixelsForCol = colQubitDensitiesPixelData[col];
            if (qubitDensityPixelsForCol.length > 0) {
                survivalRate = qubitDensityPixelsForCol[0] + qubitDensityPixelsForCol[3];
            }
            survivalRates.push(survivalRate);

            let dataHasStatsMask = col === circuitDefinition.columns.length ?
                -1 : // All wires have an output display in the after-last column.
                circuitDefinition.colDesiredSingleQubitStatsMask(col);
            qubitDensities.push(CircuitStats.scatterAndDecohereDensities(
                KetTextureUtil.pixelsToQubitDensityMatrices(qubitDensityPixelsForCol),
                circuitDefinition.numWires,
                1,
                circuitDefinition.colIsMeasuredMask(col),
                dataHasStatsMask));
        }

        return {survivalRates, qubitDensities};
    }

    /**
     * @param {!CircuitDefinition} circuitDefinition
     * @param {!number} time
     * @returns {!CircuitStats}
     */
    static _fromCircuitAtTime_noFallback(circuitDefinition, time) {
        circuitDefinition = circuitDefinition.withMinimumWireCount();
        const numWires = circuitDefinition.numWires;
        const numCols = circuitDefinition.columns.length;

        // Advance state while collecting stats into textures.
        let stateTrader = new WglTextureTrader(CircuitShaders.classicalState(0).toVec2Texture(numWires));
        let controlTex = CircuitShaders.controlMask(Controls.NONE).toBoolTexture(numWires);
        let {colQubitDensities, customStats, customStatsMap} = advanceStateWithCircuit(
            new CircuitEvalContext(
                time,
                0,
                numWires,
                Controls.NONE,
                controlTex,
                stateTrader,
                new Map()),
            circuitDefinition,
            true);
        controlTex.deallocByDepositingInPool("controlTex in _fromCircuitAtTime_noFallback");
        if (currentShaderCoder().vec2.needRearrangingToBeInVec4Format) {
            stateTrader.shadeHalveAndTrade(Shaders.packVec2IntoVec4);
        }

        // Read all texture data.
        let pixelData = Util.objectifyArrayFunc(KetTextureUtil.mergedReadFloats)({
            output: stateTrader.currentTexture,
            colQubitDensities,
            customStats});

        // -- INTERPRET --
        let {survivalRates, qubitDensities} =
            CircuitStats._extractCommonColumnStatsFromColPixelDatas(circuitDefinition, pixelData.colQubitDensities);
        let outputSuperposition = KetTextureUtil.pixelsToAmplitudes(
            pixelData.output,
            survivalRates[survivalRates.length - 1]);

        let customStatsProcessed = new Map();
        for (let {col, row, out} of customStatsMap) {
            //noinspection JSUnusedAssignment
            let func = circuitDefinition.gateInSlot(col, row).customStatPostProcesser || (e => e);
            //noinspection JSUnusedAssignment
            customStatsProcessed.set(col+":"+row, func(pixelData.customStats[out], circuitDefinition, col, row));
        }

        return new CircuitStats(
            circuitDefinition,
            time,
            survivalRates,
            qubitDensities,
            outputSuperposition,
            customStatsProcessed);
    }
}

CircuitStats.EMPTY = CircuitStats.withNanDataFromCircuitAtTime(CircuitDefinition.EMPTY, 0);

export {CircuitStats}
