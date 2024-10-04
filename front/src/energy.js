import {Chart, LinearScale, TimeSeriesScale, TimeScale, LineElement, LineController, PointElement, Tooltip, Legend, Title} from 'chart.js'
import 'chartjs-adapter-luxon'
import data from './data.json'
import {DateTime} from 'luxon'
import annotationPlugin from 'chartjs-plugin-annotation';

Chart.register(LinearScale, LineElement, LineController,  TimeSeriesScale, TimeScale, PointElement, Tooltip, Legend, Title, annotationPlugin);

function timeToLocale(ts) {
    const dt = DateTime.fromISO(ts)
    return dt.toLocaleString(DateTime.DATETIME_SHORT)
}

function adjust(prices) {
    let ret = []

    for (const pt of prices) {
        const dt = new Date(pt.startTime)
        let price = pt.price
        if (price > 0) {
            // Negative price does not mean more is paid towards the customer
            // because of VAT.
             price *= 1.255
        }
        // VAT inclusive
        // 0.5 Vattenfall margin
        // 2.776 electricity tax
        // 0.01612 security of supply fee
        price += 0.5 + 2.7776 + 0.01612
        const hour = dt.getHours()
        // Transmission fee, VAT inclusive
        if (hour >= 7 && hour < 22) {
            price += 3.20
        } else {
            price += 1.40
        }
        ret.push({
            startTime: dt,
            price: price
        })
    }
    return ret
}

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
                },
                y1: {
                    type: 'linear', display: true, position: 'right', title: {
                        display: true, text: "MW"
                    }, // grid line settings
                    grid: {
                        drawOnChartArea: false, // only want the grid lines for one axis to show up
                    },
                },
                x: {
                    type: 'timeseries',
                    time: {
                        stepSize: 60,
                    },
                    ticks: {
                        // stepSize: 60,
                        autoskip: false,
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
            },
            interaction: {
                mode: "index", intersect: false,
            },
            plugins: {
                title: {
                    display: true,
                    text: `Day-ahead prices and wind-power production, ${timeToLocale(data["startTime"])} - ${timeToLocale(data["endTime"])}, fetched ${timeToLocale(data["fetchTime"])}`
                },
                annotation: {
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
                                    return chart.scales.y.max
                                }
                            },
                            position: 'start',
                            textAlign: 'left',
                            backgroundColor: 'rgba(245,245,245, 0.7)',
                            content: [timeToLocale(now)],
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
            },{
                label: 'Actual price',
                data: adjust(data['basePrices']),
                borderColor: "#05173f",
                parsing: {
                    xAxisKey: 'startTime', yAxisKey: 'price'
                },
                yAxisID: 'y',

            },
                {
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
                borderColor: "#15dac3",
                parsing: {
                    xAxisKey: 'startTime', yAxisKey: 'energy'
                },
                yAxisID: 'y1',
            },
            {
                label: 'Solar production forecast',
                data: data['solarProductionForecast'],
                borderColor: "#dab315",
                parsing: {
                    xAxisKey: 'startTime', yAxisKey: 'energy'
                },
                yAxisID: 'y1',
            }]
        }
    });
})();
