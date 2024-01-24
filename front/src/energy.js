import {Chart, LinearScale, TimeScale, LineElement, LineController, PointElement, Legend} from 'chart.js'
import 'chartjs-adapter-luxon'
import data from './data.json'
import {DateTime} from 'luxon'
import annotationPlugin from 'chartjs-plugin-annotation';

Chart.register(LinearScale, LineElement, LineController, TimeScale, PointElement, Legend, annotationPlugin);

(async function () {
    const now = (new Date()).toISOString()
    let chart;
    new Chart(document.getElementById('energy'), {
        type: 'line', options: {

            scales: {
                y: {
                    type: 'linear', display: true, position: 'left', title: {
                        display: true, text: "c/kWh"
                    },
                }, y1: {
                    type: 'linear', display: true, position: 'right', title: {
                        display: true, text: "MW"
                    }, // grid line settings
                    grid: {
                        drawOnChartArea: false, // only want the grid lines for one axis to show up
                    },
                }, x: {
                    type: 'time', ticks: {
                        stepSize: 60,
                        callback: function (value, index, ticks) {
                            const dt = new Date(value)
                            const hour = dt.getHours()
                            const minutes = dt.getMinutes()
                            if (minutes !== 0) {
                                return ''
                            }
                            if (hour === 0) {
                                const foo = DateTime.fromJSDate(dt)
                                return foo.toLocaleString(DateTime.DATE_FULL);
                            } else {
                                return `${hour.toString().padStart(2, "0")}:${dt.getMinutes().toString().padStart(2, "0")}`;
                            }
                        }
                    }

                }
            }, interaction: {
                mode: "index", intersect: false,
            }, plugins: {
                title: {
                    display: true,
                    text: `Day-ahead prices and wind-power production, ${data["startTime"]} - ${data["endTime"]}, fetched ${data["fetchTime"]}`
                }, annotation: {
                    annotations: {
                        line1: {
                            type: 'line',
                            xMin: now,
                            xMax: now,
                            borderColor: 'rgb(255, 99, 132)',
                            borderWidth: 2,
                        }, label1: {
                            drawTime: "afterDraw",
                            transparent: true,
                            type: 'label',
                            xValue: now,
                            xAdjust: 20,
                            yAdjust: 10,
                            yValue: (context, opts) => {
                                // For whatever reason, accessing the chart object from inside this callback is hard.
                                if (context.type === "chart") {
                                    chart = context.chart
                                    // Returning the value here has no effect. It only has an effect when the `context.type` is "annotation", which happens after this callback is first called with `context.type` "chart".
                                } else {
                                    console.log(chart.scales.y.max)
                                    return chart.scales.y.max
                                }
                            },
                            position: 'start',
                            textAlign: 'left',
                            backgroundColor: 'rgba(245,245,245, 0.7)',
                            content: [now],
                            font: {
                                size: 18
                            }
                        }
                    }
                }
            },
        }, data: {
            datasets: [{
                label: 'Base price',
                data: data['basePrices'],
                borderColor: "#127194",
                parsing: {
                    xAxisKey: 'startTime', yAxisKey: 'price'
                },
                yAxisId: 'y',
            }, {
                label: 'Actual price',
                data: data['adjustedPrices'],
                borderColor: "#d0631e",
                parsing: {
                    xAxisKey: 'startTime', yAxisKey: 'price'
                },
                yAxisID: 'y',

            }, {
                label: 'Wind production',
                data: data['windProduction'],
                borderColor: "#33e50b",
                parsing: {
                    xAxisKey: 'startTime', yAxisKey: 'energy'
                },
                yAxisID: 'y1',

            }, {
                label: 'Wind production forecast',
                data: data['windProductionForecast'],
                borderColor: "#dad715",
                parsing: {
                    xAxisKey: 'startTime', yAxisKey: 'energy'
                },
                yAxisID: 'y1',

            }


            ]
        }
    });
})();
