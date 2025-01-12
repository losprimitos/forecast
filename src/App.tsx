// App.tsx

import React, { useState, DragEvent } from 'react';
import * as tf from '@tensorflow/tfjs';
import {
  LineChart as RLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

/**
 * =============================
 *     Tipos y funciones
 * =============================
 */

// Representa un punto de la serie temporal
interface TimeSeriesData {
  date: string; // en formato "YYYY-MM-DD"
  value: number;
}

/** Parsea un CSV con el delimitador elegido y retorna string[][]. */
async function parseCSV(file: File, delimiter: string = ','): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const rows = text
          .split('\n')
          .map((r) => r.trim())
          .filter((r) => r.length > 0)
          .map((r) => r.split(delimiter).map((col) => col.trim()));
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsText(file);
  });
}

/** Crea secuencias de datos (ventanas) para el entrenamiento. */
function createSequences(values: number[], windowSize: number) {
  const X: number[][] = [];
  const Y: number[] = [];

  for (let i = 0; i < values.length - windowSize; i++) {
    X.push(values.slice(i, i + windowSize));
    Y.push(values[i + windowSize]);
  }
  return { X, Y };
}

/** Calcula el MAPE, una medida de error porcentual (más bajo = mejor). */
function computeMape(actual: number[], predicted: number[]): number {
  if (actual.length !== predicted.length || actual.length === 0) return NaN;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== 0) {
      sum += Math.abs((actual[i] - predicted[i]) / actual[i]);
      count++;
    }
  }
  if (count === 0) return NaN;
  return (sum / count) * 100;
}

/** Convierte un Date en una cadena "YYYY-MM-DD". */
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Genera fechas futuras según la última fecha conocida y la cantidad de períodos. */
function generateFutureDates(lastDateStr: string, periods: number): string[] {
  const dates: string[] = [];
  const lastDate = new Date(lastDateStr);
  if (isNaN(lastDate.getTime())) {
    // Si la fecha no se entiende, creamos "Futuro +N"
    for (let i = 1; i <= periods; i++) {
      dates.push(`Futuro +${i}`);
    }
    return dates;
  }

  for (let i = 1; i <= periods; i++) {
    const next = new Date(lastDate.getTime());
    next.setDate(next.getDate() + i);
    dates.push(toISODate(next));
  }
  return dates;
}

/** Interpreta la fecha según el formato (Y/M/D, D/M/Y, M/D/Y). */
function parseDateFromFormat(dateStr: string, dateFormat: string): Date {
  const separatorsRegex = /[-/]/;
  const parts = dateStr.split(separatorsRegex);

  if (parts.length < 3) {
    return new Date(NaN);
  }

  let year: number, month: number, day: number;

  if (dateFormat === 'Y/M/D') {
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    day = parseInt(parts[2], 10);
  } else if (dateFormat === 'D/M/Y') {
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  } else if (dateFormat === 'M/D/Y') {
    month = parseInt(parts[0], 10);
    day = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  } else {
    return new Date(NaN);
  }

  return new Date(year, month - 1, day);
}

/**
 * =============================
 *     Componente principal
 * =============================
 */
function App() {
  // 1) Subir y procesar CSV
  const [delimiter, setDelimiter] = useState<string>(',');
  const [dateFormat, setDateFormat] = useState<string>('Y/M/D');
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [columns, setColumns] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);

  // 2) Elección de columnas
  const [dateColumnName, setDateColumnName] = useState<string>('');
  const [valueColumnName, setValueColumnName] = useState<string>('');

  // Datos transformados a {date, value}
  const [data, setData] = useState<TimeSeriesData[]>([]);
  const [showTable, setShowTable] = useState(false);

  // 3) Entrenamiento
  const [isTraining, setIsTraining] = useState(false);
  const [progress, setProgress] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  const [testPredictions, setTestPredictions] = useState<number[]>([]);
  const [testMape, setTestMape] = useState<number | null>(null);

  const [futurePeriods, setFuturePeriods] = useState(5);
  const [futurePredictions, setFuturePredictions] = useState<number[]>([]);
  const [futureDates, setFutureDates] = useState<string[]>([]);

  /**
   * DRAG & DROP
   */
  const handleDragOver = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const handleDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedFile(e.dataTransfer.files[0]);
    }
  };

  // Selección archivo manual
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
    }
  };

  /**
   * Subir y leer CSV
   */
  const handleUpload = async () => {
    if (!selectedFile) return;
    try {
      const rows = await parseCSV(selectedFile, delimiter);
      if (rows.length < 2) {
        throw new Error('El CSV necesita al menos una fila de cabecera y datos.');
      }
      const header = rows[0];
      const dataRows = rows.slice(1);

      setColumns(header);
      setCsvRows(dataRows);
      setData([]);

      setDateColumnName('');
      setValueColumnName('');
      setTestPredictions([]);
      setTestMape(null);
      setFuturePredictions([]);
      setFutureDates([]);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Error al leer el archivo CSV.');
    }
  };

  // Botón "Volver atrás" (re-subir CSV)
  const handleBackToCSV = () => {
    setColumns([]);
    setCsvRows([]);
    setData([]);
    setSelectedFile(null);
    setTestPredictions([]);
    setTestMape(null);
    setFuturePredictions([]);
    setFutureDates([]);
    setError(null);
  };

  /**
   * Transformar datos según columnas elegidas
   */
  const handleTransform = () => {
    if (!dateColumnName || !valueColumnName) {
      setError('Por favor, indica cuál columna es la fecha y cuál es el valor numérico.');
      return;
    }
    const dateIndex = columns.indexOf(dateColumnName);
    const valueIndex = columns.indexOf(valueColumnName);
    if (dateIndex === -1 || valueIndex === -1) {
      setError('No se encontraron esas columnas. Revisa tu selección.');
      return;
    }

    const transformed: TimeSeriesData[] = [];
    for (const row of csvRows) {
      const rawDateStr = row[dateIndex];
      const rawValueStr = row[valueIndex];
      const val = parseFloat(rawValueStr);

      if (!rawDateStr || isNaN(val)) {
        continue;
      }

      const parsedDate = parseDateFromFormat(rawDateStr, dateFormat);
      if (isNaN(parsedDate.getTime())) {
        continue;
      }
      const isoDate = toISODate(parsedDate);

      transformed.push({ date: isoDate, value: val });
    }

    setData(transformed);
    setError(null);

    setTestPredictions([]);
    setTestMape(null);
    setFuturePredictions([]);
    setFutureDates([]);
  };

  // Botón "Volver atrás" (cambiar columnas)
  const handleBackToColumns = () => {
    setData([]);
    setDateColumnName('');
    setValueColumnName('');
    setTestPredictions([]);
    setTestMape(null);
    setFuturePredictions([]);
    setFutureDates([]);
    setError(null);
  };

  /**
   * Entrenamiento
   */
  const handleTrain = async () => {
    if (data.length < 20) {
      setError('Se necesitan al menos 20 datos para entrenar.');
      return;
    }
    setError(null);
    setIsTraining(true);
    setProgress(0);
    setTimeLeft(null);
    setTestPredictions([]);
    setTestMape(null);
    setFuturePredictions([]);
    setFutureDates([]);

    const splitIndex = Math.floor(data.length * 0.8);
    const trainData = data.slice(0, splitIndex);
    const testData = data.slice(splitIndex);

    const windowSizes = [3, 5];
    const lstmUnitsArray = [32, 64];
    const totalCombos = windowSizes.length * lstmUnitsArray.length;
    let combosProcessed = 0;

    let bestMape = Infinity;
    let bestModel: tf.LayersModel | null = null;
    let bestWindowSize = 3;

    const startTime = performance.now();

    for (const w of windowSizes) {
      for (const u of lstmUnitsArray) {
        const { model, mape } = await trainAndEvaluate(trainData, testData, w, u, 1000);
        if (mape < bestMape) {
          if (bestModel) bestModel.dispose();
          bestMape = mape;
          bestModel = model;
          bestWindowSize = w;
        } else {
          model.dispose();
        }

        combosProcessed++;
        const fraction = combosProcessed / totalCombos;
        setProgress(Math.round(fraction * 100));

        const elapsed = performance.now() - startTime;
        const avgPerCombo = elapsed / combosProcessed;
        const combosLeft = totalCombos - combosProcessed;
        const estRemaining = avgPerCombo * combosLeft;
        setTimeLeft(estRemaining / 1000);
      }
    }

    if (!bestModel) {
      setError('No se pudo entrenar ningún modelo.');
      setIsTraining(false);
      return;
    }

    // Test
    const testValues = testData.map((d) => d.value);
    const predictionsOnTest: number[] = [];
    for (let i = bestWindowSize; i < testValues.length; i++) {
      const window = testValues.slice(i - bestWindowSize, i);
      const x = tf.tensor3d([window.map((v) => [v])], [1, bestWindowSize, 1]);
      const pred = bestModel.predict(x) as tf.Tensor;
      const [val] = pred.dataSync() as Float32Array;
      predictionsOnTest.push(val);
      x.dispose();
      pred.dispose();
    }

    const actualTest = testValues.slice(bestWindowSize);
    const finalMape = computeMape(actualTest, predictionsOnTest);
    setTestMape(finalMape);
    setTestPredictions(predictionsOnTest);

    // Futuro
    const fullValues = data.map((d) => d.value);
    let currentWindow = fullValues.slice(-bestWindowSize);
    const futureForecasts: number[] = [];
    for (let i = 0; i < futurePeriods; i++) {
      const x = tf.tensor3d([currentWindow.map((v) => [v])], [1, bestWindowSize, 1]);
      const pred = bestModel.predict(x) as tf.Tensor;
      const [val] = pred.dataSync() as Float32Array;
      futureForecasts.push(val);
      x.dispose();
      pred.dispose();
      currentWindow = [...currentWindow.slice(1), val];
    }
    setFuturePredictions(futureForecasts);

    const lastDate = data[data.length - 1].date;
    const futureDts = generateFutureDates(lastDate, futurePeriods);
    setFutureDates(futureDts);

    setIsTraining(false);
  };

  // Botón "Volver atrás" (re-hacer entrenamiento)
  const handleBackToData = () => {
    setTestPredictions([]);
    setTestMape(null);
    setFuturePredictions([]);
    setFutureDates([]);
    setIsTraining(false);
    setProgress(0);
    setTimeLeft(null);
    setError(null);
  };

  /**
   * Función auxiliar de entrenamiento
   */
  async function trainAndEvaluate(
    trainData: TimeSeriesData[],
    testData: TimeSeriesData[],
    windowSize: number,
    lstmUnits: number,
    epochs: number
  ): Promise<{ model: tf.LayersModel; mape: number }> {
    const trainValues = trainData.map((d) => d.value);
    const { X, Y } = createSequences(trainValues, windowSize);
    const X3D = X.map((seq) => seq.map((val) => [val]));
    const tensorX = tf.tensor3d(X3D, [X3D.length, windowSize, 1]);
    const tensorY = tf.tensor2d(Y, [Y.length, 1]);

    const model = tf.sequential();
    model.add(
      tf.layers.lstm({
        units: lstmUnits,
        returnSequences: false,
        inputShape: [windowSize, 1],
      })
    );
    model.add(tf.layers.dense({ units: 1 }));
    model.compile({
      optimizer: 'adam',
      loss: 'meanSquaredError',
    });

    await model.fit(tensorX, tensorY, { epochs });
    tensorX.dispose();
    tensorY.dispose();

    // MAPE en test
    const testValues = testData.map((d) => d.value);
    const predicted: number[] = [];
    for (let i = windowSize; i < testValues.length; i++) {
      const window = testValues.slice(i - windowSize, i);
      const x = tf.tensor3d([window.map((v) => [v])], [1, windowSize, 1]);
      const pred = model.predict(x) as tf.Tensor;
      const [val] = pred.dataSync() as Float32Array;
      predicted.push(val);
      x.dispose();
      pred.dispose();
    }
    const actual = testValues.slice(windowSize);
    const mape = computeMape(actual, predicted);

    return { model, mape };
  }

  // Preparo datos para gráficas
  const realChartData = data.map((d) => ({ date: d.date, value: d.value }));

  let testChartData: Array<{ date: string; real: number | null; predicted: number | null }> = [];
  if (data.length > 0 && testPredictions.length > 0) {
    const splitIndex = Math.floor(data.length * 0.8);
    const testArray = data.slice(splitIndex);
    const bestWindowSize = testArray.length - testPredictions.length;

    for (let i = 0; i < testArray.length; i++) {
      if (i < bestWindowSize) {
        testChartData.push({ date: testArray[i].date, real: testArray[i].value, predicted: null });
      } else {
        const predIndex = i - bestWindowSize;
        testChartData.push({
          date: testArray[i].date,
          real: testArray[i].value,
          predicted: testPredictions[predIndex],
        });
      }
    }
  }

  let futureChartData: Array<{ date: string; predicted: number }> = [];
  if (futurePredictions.length > 0 && futureDates.length === futurePredictions.length) {
    futureChartData = futureDates.map((dt, i) => ({
      date: dt,
      predicted: futurePredictions[i],
    }));
  }

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Logo y título sin márgenes extra */}
      <div className="flex items-center p-4">
        <img
          src="https://lesscode.es/wp-content/uploads/2024/04/Diseno-sin-titulo.png"
          alt="Logo"
          className="h-12 w-auto mr-4"
        />
        <br></br>
        
      </div>
    
      {/* Contenedor general con márgenes laterales más grandes */}
      <div className="px-16">
        <h1 className="text-3xl font-bold" style={{ marginBottom: '1rem' }}>
          Herramienta de Pronósticos Temporales con IA
        </h1>
        {error && (
          <div className="mb-4 p-3 bg-red-900 text-red-100 border border-red-600 rounded">
            {error}
          </div>
        )}

        {/* 1) Subir CSV */}
        {columns.length === 0 && csvRows.length === 0 && (
          <div className="space-y-4 mb-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:space-x-4">
              <div>
                <label className="block font-medium mb-1">
                  Separador (coma, punto y coma, etc.):
                </label>
                <select
                  value={delimiter}
                  onChange={(e) => setDelimiter(e.target.value)}
                  className="border border-gray-600 bg-black text-gray-300 px-2 py-1 rounded"
                >
                  <option value=",">Coma (,)</option>
                  <option value=";">Punto y coma (;)</option>
                  <option value="\t">Tabulador (\t)</option>
                </select>
              </div>

              <div>
                <label className="block font-medium mb-1">
                  Formato de fecha (Y/M/D, D/M/Y, M/D/Y):
                </label>
                <select
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value)}
                  className="border border-gray-600 bg-black text-gray-300 px-2 py-1 rounded"
                >
                  <option value="Y/M/D">Y/M/D</option>
                  <option value="D/M/Y">D/M/Y</option>
                  <option value="M/D/Y">M/D/Y</option>
                </select>
              </div>
            </div>

            <label
              className={`
                relative flex flex-col items-center justify-center w-full h-64
                border-2 border-dashed rounded-md cursor-pointer
                transition-colors duration-300
                ${
                  isDragging
                    ? 'bg-gray-800 border-gray-500'
                    : 'bg-black border-gray-600'
                }
                hover:border-gray-400 hover:bg-gray-800
              `}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                type="file"
                className="absolute w-full h-full opacity-0 cursor-pointer"
                onChange={handleFileChange}
              />
              <div className="flex flex-col items-center pointer-events-none">
                <svg
                  className={`w-16 h-16 mb-2 text-gray-500 transition-transform ${
                    isDragging ? 'animate-bounce' : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <p className="text-gray-300 text-center px-2">
                  {selectedFile
                    ? `Archivo seleccionado: ${selectedFile.name}`
                    : 'Arrastra tu archivo CSV o haz clic para seleccionar'}
                </p>
              </div>
            </label>

            <div className="text-center">
              <button
                onClick={handleUpload}
                disabled={!selectedFile}
                className={`
                  px-4 py-2 rounded font-medium
                  ${
                    selectedFile
                      ? 'bg-gray-700 hover:bg-gray-600 text-white'
                      : 'bg-gray-800 text-gray-500 cursor-not-allowed'
                  }
                `}
              >
                Leer archivo
              </button>
            </div>
          </div>
        )}

        {/* 2) Seleccionar columnas */}
        {columns.length > 0 && csvRows.length > 0 && data.length === 0 && (
          <div className="bg-black border border-gray-600 p-4 rounded space-y-4 mb-6">
            <h2 className="text-xl font-semibold">
              Selecciona columnas de fecha y valor
            </h2>

            <div>
              <label className="block font-medium">
                Columna de fecha:
              </label>
              <select
                value={dateColumnName}
                onChange={(e) => setDateColumnName(e.target.value)}
                className="border border-gray-600 bg-black text-gray-300 px-2 py-1 rounded w-full"
              >
                <option value="">-- Seleccionar --</option>
                {columns.map((col) => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-medium">
                Columna de valor:
              </label>
              <select
                value={valueColumnName}
                onChange={(e) => setValueColumnName(e.target.value)}
                className="border border-gray-600 bg-black text-gray-300 px-2 py-1 rounded w-full"
              >
                <option value="">-- Seleccionar --</option>
                {columns.map((col) => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
            </div>

            <div className="flex space-x-4">
              <button
                onClick={handleTransform}
                className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded"
              >
                Transformar datos
              </button>
              <button
                onClick={handleBackToCSV}
                className="bg-red-800 hover:bg-red-700 text-white px-4 py-2 rounded"
              >
                Volver atrás
              </button>
            </div>
          </div>
        )}

        {/* 3) Mostrar datos reales y entrenar */}
        {data.length > 0 && (
          <div className="space-y-6">
            {/* Datos reales */}
            <div className="bg-black border border-gray-600 p-4 rounded">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold">Datos (Total: {data.length})</h2>
                <button
                  onClick={handleBackToColumns}
                  className="bg-red-800 hover:bg-red-700 text-white px-3 py-1 rounded"
                >
                  Volver atrás
                </button>
              </div>
              <p className="text-gray-400 text-sm">
                Fechas en formato YYYY-MM-DD
              </p>

              <div style={{ width: '100%', height: 300 }} className="mt-3">
                <ResponsiveContainer>
                  <RLineChart data={realChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#666" />
                    <XAxis dataKey="date" stroke="#ccc" />
                    <YAxis stroke="#ccc" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#333',
                        border: '1px solid #555',
                        color: '#fff',
                      }}
                      labelStyle={{ color: '#fff' }}
                      itemStyle={{ color: '#fff' }}
                      formatter={(val) =>
                        typeof val === 'number' ? val.toFixed(2) : val
                      }
                    />
                    <Legend wrapperStyle={{ color: '#eee' }} />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#8884d8"
                      dot={false}
                      name="Valor"
                    />
                  </RLineChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-3">
                <button
                  onClick={() => setShowTable(!showTable)}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded"
                >
                  {showTable ? 'Ocultar tabla' : 'Ver tabla completa'}
                </button>
              </div>

              {showTable && (
                <div className="mt-4 overflow-auto max-h-64 border border-gray-600 rounded">
                  <table className="min-w-full text-sm text-gray-200">
                    <thead>
                      <tr>
                        <th className="border border-gray-600 px-3 py-2">
                          Fecha (YYYY-MM-DD)
                        </th>
                        <th className="border border-gray-600 px-3 py-2">
                          Valor
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.map((d, i) => (
                        <tr key={i}>
                          <td className="border border-gray-600 px-3 py-1">
                            {d.date}
                          </td>
                          <td className="border border-gray-600 px-3 py-1">
                            {d.value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Entrenamiento */}
            <div className="bg-black border border-gray-600 p-4 rounded space-y-4">
              <div className="flex items-center space-x-4">
                <div>
                  <label className="block font-medium">
                    ¿Cuántos días a futuro?
                  </label>
                  <input
                    type="number"
                    value={futurePeriods}
                    onChange={(e) => setFuturePeriods(Number(e.target.value))}
                    min={1}
                    className="border border-gray-600 bg-black text-gray-300 px-2 py-1 rounded"
                  />
                </div>

                <button
                  onClick={handleTrain}
                  disabled={isTraining}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded"
                >
                  {isTraining ? 'Entrenando...' : 'Entrenar modelo'}
                </button>

                <button
                  onClick={handleBackToData}
                  className="bg-red-800 hover:bg-red-700 text-white px-3 py-1 rounded"
                >
                  Volver atrás
                </button>
              </div>

              {isTraining && (
                <div className="w-full bg-gray-800 rounded h-6 overflow-hidden">
                  <div
                    className="bg-blue-500 h-6"
                    style={{ width: `${progress}%`, transition: 'width 0.5s' }}
                  />
                </div>
              )}
              {isTraining && (
                <div className="text-sm text-gray-400">
                  {progress}% completado
                  {timeLeft !== null && (
                    <span> — Aprox. {(timeLeft / 60).toFixed(1)} min restantes</span>
                  )}
                </div>
              )}

              {testMape !== null && (
                <div className="bg-black border border-gray-600 p-4 rounded">
                  <h3 className="font-bold text-lg mb-2">
                    Resultados en datos de prueba
                  </h3>
                  <p className="text-gray-300 mb-2">
                    Error (MAPE): {testMape.toFixed(2)}%
                  </p>
                  <div style={{ width: '100%', height: 300 }}>
                    <ResponsiveContainer>
                      <RLineChart data={testChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#666" />
                        <XAxis dataKey="date" stroke="#ccc" />
                        <YAxis stroke="#ccc" />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#333',
                            border: '1px solid #555',
                            color: '#fff',
                          }}
                          labelStyle={{ color: '#fff' }}
                          itemStyle={{ color: '#fff' }}
                          formatter={(val) =>
                            typeof val === 'number' ? val.toFixed(2) : val
                          }
                        />
                        <Legend wrapperStyle={{ color: '#eee' }} />
                        <Line
                          type="monotone"
                          dataKey="real"
                          stroke="#8884d8"
                          dot={false}
                          name="Real"
                        />
                        <Line
                          type="monotone"
                          dataKey="predicted"
                          stroke="#82ca9d"
                          dot={false}
                          name="Predicción"
                        />
                      </RLineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {futurePredictions.length > 0 && (
                <div className="bg-black border border-gray-600 p-4 rounded">
                  <h3 className="font-bold text-lg mb-2">
                    Predicción a futuro (próx {futurePeriods} días)
                  </h3>
                  <p className="text-sm text-gray-300 mb-2">
                    Pasa el ratón sobre la gráfica para ver la fecha y el valor.
                  </p>
                  <div style={{ width: '100%', height: 300 }}>
                    <ResponsiveContainer>
                      <RLineChart data={futureChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#666" />
                        <XAxis dataKey="date" stroke="#ccc" />
                        <YAxis stroke="#ccc" />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#333',
                            border: '1px solid #555',
                            color: '#fff',
                          }}
                          labelStyle={{ color: '#fff' }}
                          itemStyle={{ color: '#fff' }}
                          formatter={(val) =>
                            typeof val === 'number' ? val.toFixed(2) : val
                          }
                        />
                        <Legend wrapperStyle={{ color: '#eee' }} />
                        <Line
                          type="monotone"
                          dataKey="predicted"
                          stroke="#ff7300"
                          dot={false}
                          name="Valor futuro"
                        />
                      </RLineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
