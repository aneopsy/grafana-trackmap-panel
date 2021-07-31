import L from './leaflet/leaflet.js';
//import './leaflet/leaflet.geometryutil.js';
import './leaflet/leaflet.rotatedMarker.js';
import moment from 'moment';
//import Gradient from "javascript-color-gradient";

import { LegacyGraphHoverClearEvent, LegacyGraphHoverEvent } from '@grafana/data';
import { MetricsPanelCtrl } from 'app/plugins/sdk';

import './leaflet/leaflet.css!';
import './partials/module.css!';

// const color1 = "#FF0000";
// const color2 = "#0000FF";

function destination(latlng, heading, distance) {
  heading = (heading + 360) % 360;
  var rad = Math.PI / 180,
      radInv = 180 / Math.PI,
      R = 6378137, // approximation of Earth's radius
      lon1 = latlng.lng * rad,
      lat1 = latlng.lat * rad,
      rheading = heading * rad,
      sinLat1 = Math.sin(lat1),
      cosLat1 = Math.cos(lat1),
      cosDistR = Math.cos(distance / R),
      sinDistR = Math.sin(distance / R),
      lat2 = Math.asin(sinLat1 * cosDistR + cosLat1 *
          sinDistR * Math.cos(rheading)),
      lon2 = lon1 + Math.atan2(Math.sin(rheading) * sinDistR *
          cosLat1, cosDistR - sinLat1 * Math.sin(lat2));
  lon2 = lon2 * radInv;
  lon2 = lon2 > 180 ? lon2 - 360 : lon2 < -180 ? lon2 + 360 : lon2;
  return L.latLng([lat2 * radInv, lon2]);
}


function log(msg) {
  // uncomment for debugging
  console.log(msg);
}

function getAntimeridianMidpoints(start, end) {
  // See https://stackoverflow.com/a/65870755/369977
  if (Math.abs(start.lng - end.lng) <= 180.0){
    return null;
  }
  const start_dist_to_antimeridian = start.lng > 0 ? 180 - start.lng : 180 + start.lng;
  const end_dist_to_antimeridian = end.lng > 0 ? 180 - end.lng : 180 + end.lng;
  const lat_difference = Math.abs(start.lat - end.lat);
  const alpha_angle = Math.atan(lat_difference / (start_dist_to_antimeridian + end_dist_to_antimeridian)) * (180 / Math.PI) * (start.lng > 0 ? 1 : -1);
  const lat_diff_at_antimeridian = Math.tan(alpha_angle * Math.PI / 180) * start_dist_to_antimeridian;
  const intersection_lat = start.lat + lat_diff_at_antimeridian;
  const first_line_end = [intersection_lat, start.lng > 0 ? 180 : -180];
  const second_line_start = [intersection_lat, end.lng > 0 ? 180 : -180];

  return [L.latLng(first_line_end), L.latLng(second_line_start)];
}

export class TrackMapCtrl extends MetricsPanelCtrl {
  constructor($scope, $injector) {
    super($scope, $injector);

    log("constructor");

    _.defaults(this.panel, {
      maxDataPoints: 500,
      autoZoom: true,
      scrollWheelZoom: false,
      defaultLayer: 'OpenStreetMap',
      showLayerChanger: true,
      lineColor: 'red',
      pointColor: 'royalblue',
      windColor: 'yellow',
    });

    // Save layers globally in order to use them in options
    this.layers = {
      'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
      }),
      'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: 'Map data: &copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        maxZoom: 17
      }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Imagery &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        // This map doesn't have labels so we force a label-only layer on top of it
        forcedOverlay: L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png', {
          attribution: 'Labels by <a href="http://stamen.com">Stamen Design</a>, <a href="http://creativecommons.org/licenses/by/3.0">CC BY 3.0</a> &mdash; Map data &copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          subdomains: 'abcd',
          maxZoom: 20,
        })
      })
    };

    this.timeSrv = $injector.get('timeSrv');
    this.info = [];
    this.coordSlices = [];
    this.leafMap = null;
    this.layerChanger = null;
    this.polylines = [];
    this.wind = null;
    this.actualPositionMarker = null;
    this.hoverMarker = null;
    this.windMarker = null
    this.hoverTarget = null;
    this.setSizePromise = null;
    // this.colorGradient = new Gradient();
    // this.colorGradient.setGradient(color1, color2);

    // Panel events
    this.events.on('panel-initialized', this.onInitialized.bind(this));
    this.events.on('init-edit-mode', this.onInitEditMode.bind(this));
    this.events.on('panel-teardown', this.onPanelTeardown.bind(this));
    this.events.on('data-received', this.onDataReceived.bind(this));
    this.events.on('data-snapshot-load', this.onDataSnapshotLoad.bind(this));
    this.events.on('render', this.onRender.bind(this));
    this.events.on('refresh', this.onRefresh.bind(this));

    // Global events
    this.dashboard.events.on(LegacyGraphHoverEvent.type, this.onPanelHover.bind(this), $scope);
    this.dashboard.events.on(LegacyGraphHoverClearEvent.type, this.onPanelClear.bind(this), $scope);
  }

  onRefresh(){
    log("onRefresh")
    this.onPanelSizeChanged();
  }

  onRender(){
    log("onRender")

    // No specific event for panel size changing anymore
    // Render is called when the size changes so just call it here
    this.onPanelSizeChanged();

    // Wait until there is at least one GridLayer with fully loaded
    // tiles before calling renderingCompleted
    if (this.leafMap) {
      this.leafMap.eachLayer((l) => {
        if (l instanceof L.GridLayer){
          if (l.isLoading()) {
            l.once('load', this.renderingCompleted.bind(this));
          }
          else {
            this.renderingCompleted();
          }
        }
      });
    }
  }

  onInitialized(){
    log("onInitialized");
    this.render();
  }

  onInitEditMode() {
    log("onInitEditMode");
    this.addEditorTab('Options', 'public/plugins/aneopsy-trackmap-panel/partials/options.html', 2);
  }

  onPanelTeardown() {
    log("onPanelTeardown");
    this.$timeout.cancel(this.setSizePromise);
  }

  onPanelHover(evt) {
    log("onPanelHover");
    if (this.info.length === 0) {
      return;
    }

    // check if we are already showing the correct hoverMarker
    let target = Math.floor(evt.pos.x);
    if (this.hoverTarget && this.hoverTarget === target) {
      return;
    }

    // check for initial show of the marker
    if (this.hoverTarget == null){
      this.hoverMarker.addTo(this.leafMap);
      this.actualPositionMarker.addTo(this.leafMap);
    }

    this.hoverTarget = target;

    // Find the currently selected time and move the hoverMarker to it
    // Note that an exact match isn't always going to work due to rounding so
    // we clean that up later (still more efficient)
    let min = 0;
    let max = this.info.length - 1;
    let idx = null;
    let exact = false;
    while (min <= max) {
      idx = Math.floor((max + min) / 2);
      if (this.info[idx].timestamp === this.hoverTarget) {
        exact = true;
        break;
      }
      else if (this.info[idx].timestamp < this.hoverTarget) {
        min = idx + 1;
      }
      else {
        max = idx - 1;
      }
    }

    // Correct the case where we are +1 index off
    if (!exact && idx > 0 && this.info[idx].timestamp > this.hoverTarget) {
      idx--;
    }
    this.hoverMarker.setLatLng(this.info[idx].position);
    this.render();
  }

  onPanelClear(evt) {
    log("onPanelClear");
    // clear the highlighted circle
    this.hoverTarget = null;
    if (this.hoverMarker) {
      this.hoverMarker.removeFrom(this.leafMap);
    }
  }

  onPanelSizeChanged() {
    log("onPanelSizeChanged");
    // KLUDGE: This event is fired too soon - we need to delay doing the actual
    //         size invalidation until after the panel has actually been resized.
    this.$timeout.cancel(this.setSizePromise);
    let map = this.leafMap;
    this.setSizePromise = this.$timeout(function(){
      if (map) {
        log("Invalidating map size");
        map.invalidateSize(true);
      }}, 500
    );
  }

  applyScrollZoom() {
    let enabled = this.leafMap.scrollWheelZoom.enabled();
    if (enabled != this.panel.scrollWheelZoom){
      if (enabled){
        this.leafMap.scrollWheelZoom.disable();
      }
      else{
        this.leafMap.scrollWheelZoom.enable();
      }
    }
  }

  applyDefaultLayer() {
    let hadMap = Boolean(this.leafMap);
    this.setupMap();
    if (hadMap){
      // Re-add the default layer
      this.leafMap.eachLayer((layer) => {
        layer.removeFrom(this.leafMap);
      });
      this.layers[this.panel.defaultLayer].addTo(this.leafMap);

      // Hide/show the layer switcher
      this.leafMap.removeControl(this.layerChanger)
      if (this.panel.showLayerChanger){
        this.leafMap.addControl(this.layerChanger);
      }
    }
    this.addDataToMap();
  }

  setupMap() {
    log("setupMap");
    // Create the map or get it back in a clean state if it already exists
    if (this.leafMap) {
      this.polylines.forEach(p=>p.removeFrom(this.leafMap));
      this.actualPositionMarker.removeFrom(this.leafMap);
      this.windMarker.removeFrom(this.leafMap);
      this.onPanelClear();
      return;
    }

    // Create the map
    this.leafMap = L.map('trackmap-' + this.panel.id, {
      scrollWheelZoom: this.panel.scrollWheelZoom,
      zoomSnap: 0.5,
      zoomDelta: 1,
    });

    // Create the layer changer
    this.layerChanger = L.control.layers(this.layers)

    // Add layers to the control widget
    if (this.panel.showLayerChanger){
      this.leafMap.addControl(this.layerChanger);
    }

    // Add default layer to map
    this.layers[this.panel.defaultLayer].addTo(this.leafMap);

    // Hover marker
    this.hoverMarker = L.circleMarker(L.latLng(0, 0), {
      color: 'white',
      fillColor: this.panel.pointColor,
      fillOpacity: 1,
      weight: 2,
      radius: 7
    });

    // Events
    this.leafMap.on('baselayerchange', this.mapBaseLayerChange.bind(this));
    this.leafMap.on('boxzoomend', this.mapZoomToBox.bind(this));
  }

  mapBaseLayerChange(e) {
    // If a tileLayer has a 'forcedOverlay' attribute, always enable/disable it
    // along with the layer
    if (this.leafMap.forcedOverlay) {
      this.leafMap.forcedOverlay.removeFrom(this.leafMap);
      this.leafMap.forcedOverlay = null;
    }
    let overlay = e.layer.options.forcedOverlay;
    if (overlay) {
      overlay.addTo(this.leafMap);
      overlay.setZIndex(e.layer.options.zIndex + 1);
      this.leafMap.forcedOverlay = overlay;
    }
  }

  mapZoomToBox(e) {
    log("mapZoomToBox");
    // Find time bounds of selected coordinates
    const bounds = this.info.reduce(
      function(t, c) {
        if (e.boxZoomBounds.contains(c.position)) {
          t.from = Math.min(t.from, c.timestamp);
          t.to = Math.max(t.to, c.timestamp);
        }
        return t;
      },
      {from: Infinity, to: -Infinity}
    );

    // Set the global time range
    if (isFinite(bounds.from) && isFinite(bounds.to)) {
      // KLUDGE: Create moment objects here to avoid a TypeError that
      //         occurs when Grafana processes normal numbers
      this.timeSrv.setTime({
        from: moment.utc(bounds.from),
        to: moment.utc(bounds.to)
      });
    }
    this.render();
  }

  // Add the circles and polyline(s) to the map
  addDataToMap() {
    log("addDataToMap");
    //this.colorGradient.setMidpoint(this.coordSlices.length);

    const vessel = L.icon({
      iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 512 512"><path d="M260.884,10.5c-2.6-6.4-8.9-10.5-15.8-10.5s-13.2,4.2-15.8,10.5l-190.2,455.8c-2.7,6.4-1.2,13.7,3.6,18.7c4.9,4.9,12.2,6.4,18.6,3.9l183.8-74.2l183.7,74.1c2.1,0.8,4.3,1.2,6.4,1.2c4.5,0,8.9-1.8,12.2-5.1c4.9-4.9,6.3-12.3,3.6-18.7L260.884,10.5z M251.484,380.3c-2.1-0.8-4.2-1.2-6.4-1.2s-4.4,0.4-6.4,1.2l-152.1,61.3l158.5-379.9l158.5,380L251.484,380.3z"/></svg>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
  });

    this.polylines.length = 0;
    for (let i = 0; i < this.coordSlices.length - 1; i++) {
      const coordSlice = this.info.slice(this.coordSlices[i], this.coordSlices[i+1])
      this.polylines.push(
        L.polyline(
          coordSlice.map(x => x.position, this), {
            color: this.panel.lineColor,
            weight: 1,
          }
        ).addTo(this.leafMap)
      );
    }

    const vesselPos = this.info[this.info.length - 1].position
    const windAngle = this.info[this.info.length - 1].wind * 180/3.1415

    this.actualPositionMarker = L.marker(vesselPos, {icon: vessel, rotationAngle: this.info[this.info.length - 1].heading * 180/3.1415}).addTo(this.leafMap);

    const windPt = destination(vesselPos, windAngle, 50);
    this.windMarker = L.polyline(
      [vesselPos, windPt], {
        color: this.panel.windColor,
        weight: 1,
      }
    ).addTo(this.leafMap)
    this.zoomToFit();
  }

  zoomToFit(){
    log("zoomToFit");
    if (this.panel.autoZoom && this.polylines.length>0){
      var bounds = this.polylines[0].getBounds();
      this.polylines.forEach(p => bounds.extend(p.getBounds()));

      if (bounds.isValid()){
        this.leafMap.fitBounds(bounds);
      }
      else {
        this.leafMap.setView([0, 0], 1);
      }
    }
    this.render();
  }

  refreshColors() {
    log("refreshColors");
    this.polylines.forEach(p => {
      p.setStyle({
        color: this.panel.lineColor
      })
    });
    if (this.windMarker){
      this.windMarker.setStyle({
        fillColor: this.panel.windColor,
      });
    }
    if (this.hoverMarker){
      this.hoverMarker.setStyle({
        fillColor: this.panel.pointColor,
      });
    }
    this.render();
  }

  onDataReceived(data) {
    log("onDataReceived");
    log(data);
    this.setupMap();

    if (data.length === 0 || data.length < 3) {
      // No data or incorrect data, show a world map and abort
      this.leafMap.setView([0, 0], 1);
      this.render();
      return;
    }

    // Asumption is that there are an equal number of properly matched timestamps
    // TODO: proper joining by timestamp?
    this.info.length = 0;
    this.coordSlices.length = 0;
    this.coordSlices.push(0)
    const lats = data[0].datapoints;
    const lons = data[1].datapoints;
    const heading = data[2].datapoints;
    const wind = data[3].datapoints;
    for (let i = 0; i < lats.length; i++) {
      if (lats[i][0] == null || lons[i][0] == null || heading[i][0] == null ||
          (lats[i][0] == 0 && lons[i][0] == 0) ||
          lats[i][1] !== lons[i][1]) {
        continue;
      }
      const pos = L.latLng(lats[i][0], lons[i][0])

      if (this.info.length > 0){
        // Deal with the line between last point and this one crossing the antimeridian:
        // Draw a line from the last point to the antimeridian and another from the anitimeridian
        // to the current point.
        const midpoints = getAntimeridianMidpoints(this.info[this.info.length-1].position, pos);
        if (midpoints != null){
          // Crossed the antimeridian, add the points to the coords array
          const lastTime = this.info[this.info.length-1].timestamp
          midpoints.forEach(p => {
            this.info.push({
              position: p,
              timestamp: lastTime + ((lats[i][1] - lastTime)/2)
            })
          });
          // Note that we need to start drawing a new line between the added points
          this.coordSlices.push(this.info.length - 1)
        }
      }

      this.info.push({
        position: pos,
        heading: heading[i][0],
        wind: wind[i][0]
      });
        timestamp: lats[i][1]

    }
    this.coordSlices.push(this.info.length)
    this.addDataToMap();
  }

  onDataSnapshotLoad(snapshotData) {
    log("onSnapshotLoad");
    this.onDataReceived(snapshotData);
  }
}

TrackMapCtrl.templateUrl = 'partials/module.html';
